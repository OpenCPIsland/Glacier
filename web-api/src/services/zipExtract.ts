/**
 * A small, strict zip reader for CDN release uploads. Supports stored and
 * deflate entries only and refuses everything else: encryption, zip64,
 * multi-disk, links and other special files, odd names, duplicates, wrong
 * sizes or CRCs. All entries are checked before any file is written, and
 * each entry's inflate is capped at its declared size so a bomb can't grow.
 * Uploads are made by staff (cdn.edit) but the content is still untrusted.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

export interface ZipLimits { maxEntries: number; maxTotalBytes: number; maxFileBytes: number }
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 5000, maxTotalBytes: 1024 ** 3, maxFileBytes: 256 * 1024 ** 2 };

interface Entry { name: string; dir: boolean; method: number; crc: number; csize: number; usize: number; offset: number }

const err = (m: string) => new Error(`zip: ${m}`);
const show = (s: string) => JSON.stringify(s.slice(0, 80));

function safeName(raw: string): { name: string; dir: boolean } {
    const dir = raw.endsWith("/");
    const name = dir ? raw.slice(0, -1) : raw;
    if (!name || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw err(`bad path ${show(raw)}`);
    for (const seg of name.split("/")) if (seg === "" || seg === "." || seg === "..") throw err(`bad path ${show(raw)}`);
    return { name, dir };
}

function readDirectory(buf: Buffer, lim: ZipLimits): Entry[] {
    if (buf.length < 22) throw err("not a zip file");
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw err("not a zip file (no end record)");
    const disk = buf.readUInt16LE(eocd + 4), cdDisk = buf.readUInt16LE(eocd + 6);
    const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
    if (disk !== 0 || cdDisk !== 0) throw err("multi-disk zips are not supported");
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw err("zip64 is not supported");
    if (count > lim.maxEntries) throw err(`too many entries (${count}, max ${lim.maxEntries})`);
    if (cdOffset + cdSize > eocd) throw err("not a zip file (bad directory)");

    const entries: Entry[] = [];
    const seen = new Set<string>();
    let total = 0, p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw err("not a zip file (bad directory entry)");
        const madeBy = buf.readUInt16LE(p + 4), flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
        const ext = buf.readUInt32LE(p + 38), offset = buf.readUInt32LE(p + 42);
        if (p + 46 + nameLen > buf.length) throw err("not a zip file (bad name)");
        const raw = buf.toString("utf8", p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;

        const { name, dir } = safeName(raw);
        if (flags & 1) throw err(`encrypted entries are not supported (${show(raw)})`);
        if (method !== 0 && method !== 8) throw err(`unsupported compression method ${method} (${show(raw)})`);
        if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw err("zip64 is not supported");
        if (madeBy >> 8 === 3) { // made on Unix: the mode is in the high 16 bits
            const type = (ext >>> 16) & 0o170000;
            if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw err(`links and special files are not allowed (${show(raw)})`);
        }
        const key = name.toLowerCase();
        if (seen.has(key)) throw err(`duplicate entry ${show(raw)}`);
        seen.add(key);
        if (!dir) {
            if (usize > lim.maxFileBytes) throw err(`file too large (${show(raw)})`);
            total += usize;
            if (total > lim.maxTotalBytes) throw err("total size too large");
        }
        entries.push({ name, dir, method, crc, csize, usize, offset });
    }
    return entries;
}

/** Extracts into destDir (which must exist). Returns the number of files. Throws before writing anything if the directory is bad; a later failure may leave partial files, so callers extract into a scratch folder. */
export function extractZip(zipPath: string, destDir: string, lim: ZipLimits = DEFAULT_ZIP_LIMITS): number {
    const buf = readFileSync(zipPath);
    const entries = readDirectory(buf, lim);
    const base = resolve(destDir);
    let files = 0;
    for (const e of entries) {
        const out = resolve(join(base, e.name));
        if (out !== base && !out.startsWith(base + sep)) throw err(`bad path ${show(e.name)}`);
        if (e.dir) { mkdirSync(out, { recursive: true }); continue; }

        if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw err(`bad local header for ${show(e.name)}`);
        const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
        if (start + e.csize > buf.length) throw err(`truncated data for ${show(e.name)}`);
        const packed = buf.subarray(start, start + e.csize);
        let data: Buffer;
        if (e.method === 0) {
            if (e.csize !== e.usize) throw err(`size mismatch for ${show(e.name)}`);
            data = packed;
        } else {
            try { data = inflateRawSync(packed, { maxOutputLength: Math.max(e.usize, 1) }); } catch { throw err(`size mismatch or bad data for ${show(e.name)}`); }
            if (data.length !== e.usize) throw err(`size mismatch for ${show(e.name)}`);
        }
        if ((Bun.hash.crc32(data) >>> 0) !== e.crc) throw err(`CRC mismatch for ${show(e.name)}`);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, data, { flag: "wx" });
        files++;
    }
    return files;
}
