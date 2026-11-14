// A minimal zip writer for tests, with knobs for crafting bad archives.
import { deflateRawSync } from "node:zlib";

export interface Ent { name: string; data?: Uint8Array | string; method?: 0 | 8 | 12; flags?: number; crc?: number; unixMode?: number; declaredSize?: number; raw?: Uint8Array }
const u16 = (n: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; };
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
export function makeZip(ents: Ent[], opts: { truncate?: number } = {}): Uint8Array {
    const enc = new TextEncoder();
    const local: Uint8Array[] = [], central: Uint8Array[] = [];
    let offset = 0;
    for (const e of ents) {
        const data = typeof e.data === "string" ? enc.encode(e.data) : (e.data ?? new Uint8Array());
        const method = e.method ?? 8;
        const body = e.raw ?? (method === 8 ? deflateRawSync(data) : data);
        const crc = e.crc ?? Bun.hash.crc32(data);
        const usize = e.declaredSize ?? data.length;
        const name = enc.encode(e.name);
        const hdr = cat(u32(0x04034b50), u16(20), u16(e.flags ?? 0), u16(method), u16(0), u16(0x21), u32(crc), u32(body.length), u32(usize), u16(name.length), u16(0), name);
        local.push(hdr, body);
        central.push(cat(u32(0x02014b50), u16(0x031e), u16(20), u16(e.flags ?? 0), u16(method), u16(0), u16(0x21), u32(crc), u32(body.length), u32(usize), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(((e.unixMode ?? (e.name.endsWith("/") ? 0o040755 : 0o100644)) << 16) >>> 0), u32(offset), name));
        offset += hdr.length + body.length;
    }
    const cdir = cat(...central);
    const eocd = cat(u32(0x06054b50), u16(0), u16(0), u16(ents.length), u16(ents.length), u32(cdir.length), u32(offset), u16(0));
    const all = cat(...local, cdir, eocd);
    return opts.truncate ? all.slice(0, opts.truncate) : all;
}
