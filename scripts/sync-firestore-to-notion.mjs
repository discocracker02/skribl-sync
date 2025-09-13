// scripts/sync-firestore-to-notion.mjs
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Client } from "@notionhq/client";

/**
 * ENV (provided by GitHub Actions secrets)
 * Required:
 *  - NOTION_TOKEN
 *  - NOTION_DATABASE_ID
 *  - FIREBASE_SA_JSON  (stringified service account JSON)
 *
 * Optional:
 *  - FIREBASE_UID          (limit sync to a single user’s notes)
 *  - NOTION_TITLE_PROP     (defaults to "Content")
 *  - NOTION_DELETE_MODE    (informational; Notion API archives pages)
 */
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const FIREBASE_SA_JSON = process.env.FIREBASE_SA_JSON;

const FIREBASE_UID = process.env.FIREBASE_UID || "";
const TITLE_PROP = process.env.NOTION_TITLE_PROP || "Content";
const NOTION_DELETE_MODE = (process.env.NOTION_DELETE_MODE || "archive").toLowerCase();

if (!FIREBASE_SA_JSON || !NOTION_TOKEN || !NOTION_DATABASE_ID) {
  console.error("Missing FIREBASE_SA_JSON or NOTION_TOKEN or NOTION_DATABASE_ID");
  process.exit(1);
}

// --- Clients ---
const sa = JSON.parse(FIREBASE_SA_JSON);
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const notion = new Client({ auth: NOTION_TOKEN });

// --- Helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE_DELAY_MS = 220; // gentle rate limiting
const trim = (s, n = 2000) => (typeof s === "string" ? s.slice(0, n) : "");

function toISO(d) {
  try {
    if (!d) return new Date().toISOString();
    if (typeof d === "object" && d._seconds != null) {
      return new Date(d._seconds * 1000).toISOString();
    }
    return new Date(d).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// Build Notion properties for a note
function buildNotionProps(firebaseId, note) {
  const content = trim(note.content || "");
  const createdISO = toISO(note.updatedAt || note.createdAt || new Date().toISOString());
  const tags = Array.isArray(note.tags) ? note.tags : [];
  const category = note.sectionId || "Notes";

  const props = {};
  props[TITLE_PROP] = { title: [{ type: "text", text: { content: content || "—" } }] };
  props.created_at = { date: { start: createdISO } };
  props.tags = { multi_select: tags.map((t) => ({ name: String(t).slice(0, 100) })) };
  props.category = { select: { name: String(category).slice(0, 100) } };
  props.firebase_id = { rich_text: [{ type: "text", text: { content: firebaseId } }] };
  return props;
}

function getFirebaseIdFromPage(page) {
  const prop = page.properties?.firebase_id;
  if (!prop || prop.type !== "rich_text" || !Array.isArray(prop.rich_text)) return "";
  const first = prop.rich_text[0];
  return (first?.plain_text || first?.text?.content || "").trim();
}

async function findPageByFirebaseId(firebaseId) {
  const resp = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: { property: "firebase_id", rich_text: { equals: firebaseId } },
    page_size: 1,
  });
  return resp.results[0];
}

async function upsertNote(firebaseId, note) {
  const props = buildNotionProps(firebaseId, note);
  const existing = await findPageByFirebaseId(firebaseId);

  if (existing) {
    await notion.pages.update({ page_id: existing.id, properties: props, archived: false });
    console.log(`Updated ${firebaseId}`);
    return "updated";
  } else {
    await notion.pages.create({ parent: { database_id: NOTION_DATABASE_ID }, properties: props });
    console.log(`Created ${firebaseId}`);
    return "created";
  }
}

async function archivePage(pageId) {
  await notion.pages.update({ page_id: pageId, archived: true });
}

async function getAllNotionPages() {
  const pages = [];
  let cursor = undefined;
  do {
    const resp = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
    await sleep(RATE_DELAY_MS);
  } while (cursor);
  return pages;
}

// --- Main ---
async function run() {
  console.log("Sync start…");
  console.log(`Filter UID: ${FIREBASE_UID || "(none; syncing all)"}`);
  console.log(`Title prop: ${TITLE_PROP}`);
  console.log(`Delete mode: ${NOTION_DELETE_MODE} (Notion archives pages)`);

  // 1) Fetch Firestore notes (optionally filtered by uid)
  let q = db.collection("notes");
  if (FIREBASE_UID) q = q.where("uid", "==", FIREBASE_UID);

  const snap = await q.get();
  console.log(`Found ${snap.size} Firestore notes matching filter.`);
  const fsDocs = snap.docs;
  const fsIds = new Set(fsDocs.map((d) => d.id));

  // 2) Upsert to Notion
  let created = 0,
    updated = 0,
    failed = 0;

  for (const doc of fsDocs) {
    try {
      const res = await upsertNote(doc.id, doc.data());
      if (res === "created") created++;
      else updated++;
    } catch (e) {
      failed++;
      console.error(`Failed upsert for ${doc.id}:`, e?.message || e);
    }
    await sleep(RATE_DELAY_MS);
  }

  // 3) Delete-sync: archive Notion pages whose firebase_id is not in Firestore
  let archived = 0,
    skipped = 0;

  const notionPages = await getAllNotionPages();
  for (const page of notionPages) {
    const fid = getFirebaseIdFromPage(page);
    if (!fid) {
      skipped++; // page not managed by this sync
      continue;
    }
    if (!fsIds.has(fid)) {
      try {
        await archivePage(page.id);
        archived++;
        console.log(`Archived Notion page for deleted note ${fid}`);
      } catch (e) {
        failed++;
        console.error(`Failed to archive ${fid}:`, e?.message || e);
      }
      await sleep(RATE_DELAY_MS);
    }
  }

  console.log(
    `Done. Created: ${created}, Updated: ${updated}, Archived(deleted): ${archived}, Skipped: ${skipped}, Failed: ${failed}`
  );
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
