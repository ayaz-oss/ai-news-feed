#!/usr/bin/env bun
// AI news digest -> Telegram, via @ayaz_feeds_bot.
// Run: bun run feed.ts [--dry]
//
// Reads feeds.json for sources, .env for credentials, seen.json for dedupe.
// Paths resolve against this file, not the cwd, so Task Scheduler can run it
// from anywhere.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");

type Source = { name: string; url: string; tag: string; filter: boolean };
type Config = {
  windowDays: number;
  maxItems: number;
  keywords: string[];
  sources: Source[];
};
type Item = { title: string; link: string; date: Date; source: string; tag: string };

// ---------------------------------------------------------------- env + state

// Real environment wins, so CI injects secrets without a .env on disk; the
// file is the local-development fallback.
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const path = join(HERE, ".env");

  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
  for (const key of ["FEEDS_BOT_TOKEN", "FEEDS_CHAT_ID"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

function loadSeen(): Set<string> {
  const path = join(HERE, "seen.json");
  if (!existsSync(path)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(path, "utf8")) as string[]);
  } catch {
    // A corrupt state file should cost us one duplicated digest, not a crash.
    console.warn("seen.json unreadable, starting fresh");
    return new Set();
  }
}

function saveSeen(seen: Set<string>) {
  // Keep the tail only — the recency window means old links can never resurface.
  const keep = [...seen].slice(-500);
  writeFileSync(join(HERE, "seen.json"), JSON.stringify(keep, null, 0));
}

// ------------------------------------------------------------------- parsing

function decode(raw: string): string {
  return (
    raw
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, "")
      // Numeric entities first: feeds are full of &#8217; and friends, and
      // leaving them raw means escapeHtml later mangles them into &amp;#8217;.
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      // &amp; last, so "&amp;lt;" resolves in the right order.
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function firstTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decode(m[1]) : null;
}

function extractLink(block: string): string | null {
  // Atom puts the URL in an attribute; RSS puts it in the element body.
  const atom =
    block.match(/<link[^>]+rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ??
    block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (atom) return atom[1];
  const rss = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  return rss ? decode(rss[1]) : null;
}

function parseFeed(xml: string, source: Source): Item[] {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  const items: Item[] = [];

  for (const block of blocks) {
    const title = firstTag(block, "title");
    const link = extractLink(block);
    if (!title || !link) continue;

    const stamp =
      firstTag(block, "pubDate") ??
      firstTag(block, "published") ??
      firstTag(block, "updated") ??
      firstTag(block, "dc:date");
    const date = stamp ? new Date(stamp) : new Date(NaN);
    if (isNaN(date.getTime())) continue; // undateable items break the window

    items.push({ title, link, date, source: source.name, tag: source.tag });
  }
  return items;
}

// ------------------------------------------------------------------ delivery

// The dev feeds out-publish the education ones by an order of magnitude, so a
// straight "most recent N" digest is all dev and the education section never
// appears. Reserve a share for each tag, then let either spend what the other
// didn't use.
function allocate(sorted: Item[], cfg: Config): Item[] {
  const reserve: Record<string, number> = { dev: 8, education: 4 };
  const picked: Item[] = [];
  const spare: Item[] = [];

  for (const item of sorted) {
    if ((reserve[item.tag] ?? 0) > 0) {
      reserve[item.tag]--;
      picked.push(item);
    } else {
      spare.push(item);
    }
  }
  picked.push(...spare.slice(0, cfg.maxItems - picked.length));
  return picked.sort((a, b) => b.date.getTime() - a.date.getTime());
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildDigest(items: Item[]): string {
  const groups: [string, string][] = [
    ["dev", "AI for developers"],
    ["education", "AI in education"],
  ];
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  const parts = [`<b>AI digest — ${today}</b>`];
  for (const [tag, heading] of groups) {
    const group = items.filter((i) => i.tag === tag);
    if (!group.length) continue;
    parts.push(`\n<b>${heading}</b>`);
    for (const item of group) {
      parts.push(
        `• <a href="${escapeHtml(item.link)}">${escapeHtml(item.title)}</a>` +
          `  <i>${escapeHtml(item.source)}</i>`,
      );
    }
  }
  return parts.join("\n");
}

async function send(token: string, chatId: string, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
  });
  const body = (await res.json()) as { ok: boolean; description?: string };
  if (!body.ok) throw new Error(`Telegram rejected the message: ${body.description}`);
}

// ---------------------------------------------------------------------- main

async function main() {
  const cfg: Config = JSON.parse(readFileSync(join(HERE, "feeds.json"), "utf8"));
  const env = loadEnv();
  const token = env.FEEDS_BOT_TOKEN;
  const chatId = env.FEEDS_CHAT_ID;
  if (!token || !chatId) throw new Error("FEEDS_BOT_TOKEN and FEEDS_CHAT_ID required in .env");

  const seen = loadSeen();
  const cutoff = Date.now() - cfg.windowDays * 86_400_000;
  const keywords = cfg.keywords.map((k) => k.toLowerCase());
  const fresh: Item[] = [];

  const results = await Promise.allSettled(
    cfg.sources.map(async (source) => {
      const res = await fetch(source.url, {
        headers: { "User-Agent": "Mozilla/5.0 (ai-news-feed)" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { source, items: parseFeed(await res.text(), source) };
    }),
  );

  for (const [i, result] of results.entries()) {
    const source = cfg.sources[i];
    if (result.status === "rejected") {
      // One dead feed must not cost you the whole digest.
      console.warn(`${source.name}: ${result.reason}`);
      continue;
    }
    let kept = 0;
    for (const item of result.value.items) {
      if (item.date.getTime() < cutoff) continue;
      if (seen.has(item.link)) continue;
      if (source.filter && !keywords.some((k) => item.title.toLowerCase().includes(k))) continue;
      fresh.push(item);
      kept++;
    }
    console.log(`${source.name}: ${result.value.items.length} items, ${kept} new`);
  }

  if (!fresh.length) {
    console.log("nothing new — no message sent");
    return;
  }

  fresh.sort((a, b) => b.date.getTime() - a.date.getTime());
  const digest = allocate(fresh, cfg);
  const text = buildDigest(digest);

  if (DRY) {
    console.log("\n--- dry run, not sending ---\n" + text);
    return;
  }

  await send(token, chatId, text);
  for (const item of digest) seen.add(item.link);
  saveSeen(seen);
  console.log(`sent ${digest.length} items`);
}

main().catch((err) => {
  console.error(`failed: ${err.message}`);
  process.exit(1);
});
