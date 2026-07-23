// Tiny persistent conversation store.
//
// Keeps role-tagged messages ({role, content}) per conversation id, in a single
// JSON file. Zero dependencies. Writes are synchronous and atomic-ish (write to a
// temp file then rename) so a crash mid-write won't corrupt the store.

import fs from "node:fs";
import path from "node:path";

const FILE = process.env.MEMORY_FILE || path.join(process.cwd(), "memory.json");

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {}; // missing or unreadable -> empty store
  }
}

function writeAll(data) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

// Return a *copy* of a conversation's messages (mutating it won't touch the store
// until you call save()).
export function getHistory(conversationId) {
  const all = readAll();
  const list = all[conversationId];
  return Array.isArray(list) ? list.map((m) => ({ ...m })) : [];
}

// Replace a conversation's messages and persist.
export function saveHistory(conversationId, messages) {
  const all = readAll();
  all[conversationId] = messages;
  writeAll(all);
}

// Clear one conversation. Returns true if it existed.
export function clearConversation(conversationId) {
  const all = readAll();
  if (!(conversationId in all)) return false;
  delete all[conversationId];
  writeAll(all);
  return true;
}

export const MEMORY_FILE = FILE;
