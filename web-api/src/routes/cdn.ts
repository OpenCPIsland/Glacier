/**
 * The island client's CDN boot files (see services/cdnManifest.ts):
 *
 * - GET /__mapping_cpremix_prod.json
 * - GET /manifests/cpipe.<H1>.json
 * - GET /cdn.disney.io/<H2>/ClientManifestDirectory.json
 *
 * The mapping and manifest are 404 while the admin's switch is off, and for
 * any hash but the current one, so a client falls back to its embedded
 * content. A directory is served for any hash published before. The
 * config is read on every request, so a change applies at once. Query
 * parameters (access_token, cacheBust) are ignored.
 */
import express from "express";
import { getCdnConfig, getPublishedDirectory, releaseLoader, releasesDir } from "../services/cdnConfig.ts";
import { releaseFilePath, isReleaseId } from "../services/cdnReleases.ts";
import { buildCdnFiles, type CdnFiles } from "../services/cdnManifest.ts";

const router = express.Router();

function current(req: express.Request): CdnFiles | null {
    const cfg = getCdnConfig();
    if (!cfg.enabled) return null;
    const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
    return buildCdnFiles(cfg, `${proto}://${req.get('host')}`, releaseLoader);
}

// Bodies go out as the exact strings that were hashed, never re-serialised.
const send = (res: express.Response, body: string, cache: string) =>
    res.set("Cache-Control", cache).type("application/json").send(body);

// The client caches whatever body these paths return (even a 404's JSON, as
// a broken directory), so every refusal here is a 404 with no body.
const refuse = (res: express.Response) => res.status(404).end();

router.get("/__mapping_cpremix_prod.json", (req, res) => {
    const f = current(req);
    if (!f) return refuse(res);
    send(res, f.mapping, "no-store");
});

const MANIFEST_NAME = /^cpipe\.[0-9a-f]{16}\.json$/;
router.get("/manifests/:file", (req, res, next) => {
    if (!MANIFEST_NAME.test(req.params.file)) return next();
    const f = current(req);
    if (!f || req.params.file !== `cpipe.${f.h1}.json`) return refuse(res);
    send(res, f.manifest, "public, max-age=300");
});

// Any published directory is served, even while the switch is off: it is
// named by the hash of its own body and lists embedded content only, so
// serving it is harmless, while a 404 mid-boot would be cached by the client.
router.get("/cdn.disney.io/:h2/ClientManifestDirectory.json", (req, res) => {
    const f = current(req);
    const body = f && f.h2 === req.params.h2 ? f.directory : getPublishedDirectory(req.params.h2);
    if (!body) return refuse(res);
    send(res, body, "public, max-age=300");
});

// A content release's files (services/cdnReleases.ts): the Addressables layout
// <release>/<Platform>/<file>, and the older <release>/ClientBundles/<platform>/<file>.
// Only files the release lists are served, whether or not the switch is on:
// nothing points at them while it's off, and a 404 mid-download is cached by
// the client. Cache headers go out only with a successful send, so a failed
// send (missing file, bad range) is never cached as immutable.
function sendReleaseFile(res: express.Response, path: string | null) {
    if (!path) return refuse(res);
    res.sendFile(path, { headers: { "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "application/octet-stream" } }, (err: any) => {
        if (!err || res.headersSent) return;
        res.removeHeader("Cache-Control");
        if (err.status === 416) return res.set("Cache-Control", "no-store").status(416).end();
        res.removeHeader("Content-Range");
        res.set("Cache-Control", "no-store");
        refuse(res);
    });
}

router.get("/cdn.disney.io/:id/ClientBundles/:platform/:file", (req, res) => {
    const { id, platform, file } = req.params;
    sendReleaseFile(res, isReleaseId(id) ? releaseFilePath(releasesDir(), id, `ClientBundles/${platform}/${file}`) : null);
});

router.get("/cdn.disney.io/:id/:platform/:file", (req, res) => {
    const { id, platform, file } = req.params;
    sendReleaseFile(res, isReleaseId(id) ? releaseFilePath(releasesDir(), id, `${platform}/${file}`) : null);
});

// Anything else under the CDN root is an empty 404 too, not the app's JSON
// "Route not found", which the client would cache.
router.use("/cdn.disney.io", (_req, res) => refuse(res));

export default router;
