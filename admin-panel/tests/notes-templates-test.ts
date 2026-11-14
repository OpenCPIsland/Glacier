// admin.db: staff notes on players and the reason templates staff pick
// when they act. Both are panel-only data.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeChecker } from "../../tools/lib/harness.ts";
import { openStore, type StaffRow } from "../src/store.ts";
import { addNote, listNotes, deleteNote } from "../src/notes.ts";
import { listTemplates, upsertTemplate, setTemplateDisabled, SEED_TEMPLATES } from "../src/templates.ts";

const { check, finish } = makeChecker();
const path = join(mkdtempSync(join(tmpdir(), "admin-notes-")), "admin.db");
let store = openStore(path, ["boss@x.com"]);
const throws = (fn: () => unknown) => { try { fn(); return false; } catch (e) { return e instanceof RangeError; } };
const staff = (email: string, role: StaffRow["role"]): StaffRow => ({ email, role, extras: [], linkedSwid: null, disabled: false, addedBy: "x", addedAt: 0, updatedAt: 0, isConfigOwner: false });
const modA = staff("a@x.com", "moderator"), modB = staff("b@x.com", "moderator"), adm = staff("c@x.com", "admin");

// Notes
const n1 = addNote(store, "{p1}", modA.email, "  Talked to them in game.  ");
const n2 = addNote(store, "{p1}", modB.email, "Second note");
addNote(store, "{p2}", modA.email, "Other player");
let notes = listNotes(store, "{p1}", false);
check(notes.length === 2 && notes[0]!.id === n2 && notes[1]!.body === "Talked to them in game.", `newest first, trimmed (${JSON.stringify(notes)})`);
check(notes[1]!.author === "a@x.com" && typeof notes[1]!.at === "number", "author and time");
check(throws(() => addNote(store, "{p1}", modA.email, "   ")), "an empty note is refused");
check(throws(() => addNote(store, "{p1}", modA.email, "x".repeat(1001))), "a 1001-char note is refused");
check(!throws(() => addNote(store, "{p1}", modA.email, "x".repeat(1000))), "1000 chars is fine");
check(deleteNote(store, "{p2}", n1, modA) === "none" && listNotes(store, "{p1}", false).some((n) => n.id === n1), "a note can only be deleted through its own player: another swid → none, note kept");
check(deleteNote(store, "{p1}", n1, modB) === "not yours", "a moderator can't delete someone else's note");
check(deleteNote(store, "{p1}", n1, modA) === "deleted", "the author deletes their own");
check(deleteNote(store, "{p1}", n1, modA) === "none", "deleting twice → none");
check(deleteNote(store, "{p1}", n2, adm) === "deleted", "an admin deletes anyone's");
check(deleteNote(store, "{p1}", 99999, adm) === "none", "unknown note → none");
notes = listNotes(store, "{p1}", false);
check(notes.length === 1, "deleted notes are hidden");
const all = listNotes(store, "{p1}", true);
check(all.length === 3 && all.some((n) => n.id === n1 && n.deletedBy === "a@x.com" && typeof n.deletedAt === "number"), "but kept, with who deleted them");

// Templates
let t = listTemplates(store);
check(t.map((x) => x.label).join("|") === SEED_TEMPLATES.map((x) => x.label).join("|"), `seeded once, in order (${t.map((x) => x.label)})`);
check(SEED_TEMPLATES.some((x) => x.label === "Asked to be kicked" && x.appliesTo === "kick"), "a kick-only seed");
check(listTemplates(store, "mute").every((x) => x.appliesTo === "any" || x.appliesTo === "mute") && !listTemplates(store, "mute").some((x) => x.label === "Asked to be kicked"), "filtered by action, any included");
check(listTemplates(store, "kick").some((x) => x.label === "Asked to be kicked"), "kick sees the kick-only one");
const spam = t.find((x) => x.label === "Spamming chat")!;
setTemplateDisabled(store, spam.id, true);
check(!listTemplates(store).some((x) => x.id === spam.id) && listTemplates(store, undefined, true).some((x) => x.id === spam.id && x.disabled), "disabled templates are hidden unless asked for");
const id = upsertTemplate(store, { label: "Ban evasion", appliesTo: "ban", sort: 5 });
check(listTemplates(store, "ban").some((x) => x.id === id && x.label === "Ban evasion"), "a new template");
upsertTemplate(store, { id, label: "Ban evasion (alt account)", appliesTo: "ban", sort: 5 });
check(listTemplates(store, "ban").find((x) => x.id === id)?.label === "Ban evasion (alt account)", "edit in place");
check(throws(() => upsertTemplate(store, { label: "", appliesTo: "any", sort: 0 })), "an empty label is refused");
check(throws(() => upsertTemplate(store, { label: "x".repeat(81), appliesTo: "any", sort: 0 })), "an 81-char label is refused");
check(throws(() => upsertTemplate(store, { label: "x", appliesTo: "nuke" as any, sort: 0 })), "an unknown action is refused");
check(throws(() => upsertTemplate(store, { label: "x — y", appliesTo: "any", sort: 0 })), "a label can't hold the reason separator");

// Seeding happens once: a deleted seed stays deleted after reopening.
store.db.query("DELETE FROM reason_templates WHERE label = 'Exploiting a bug'").run();
store.db.close();
store = openStore(path, ["boss@x.com"]);
check(!listTemplates(store).some((x) => x.label === "Exploiting a bug"), "reopening doesn't re-seed");
check(listNotes(store, "{p1}", false).length === 1, "notes survive reopening");

finish();
