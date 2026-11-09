// Public release downloads only. No uploads, directory listing, billing or secrets.
const PREFIX = '/downloads/nodemend/';
export function releaseKey(url) {
  const pathname = new URL(url).pathname;
  if (!pathname.startsWith(PREFIX)) return null;
  const key = pathname.slice(PREFIX.length);
  return /^1\.5\.0\/(NodeMend-portable\.exe|SHA256SUMS\.txt|README\.txt|LICENSE\.txt|testdisk-7\.2-source\.tar\.bz2)$/.test(key) ? key : null;
}
export default {
  async fetch(request, env) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    if (new URL(request.url).pathname === PREFIX) return Response.redirect('https://namer-lavan.com/downloads/nodemend', 308);
    const key = releaseKey(request.url);
    if (!key) return new Response('Not found', { status: 404 });
    const object = request.method === 'HEAD' ? await env.RELEASES.head(key) : await env.RELEASES.get(key);
    if (!object) return new Response('Not found', { status: 404 });
    const headers = new Headers({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${key.split('/').pop()}"`, 'Content-Length': String(object.size), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=3600', ETag: object.httpEtag });
    if (request.headers.get('If-None-Match') === object.httpEtag) return new Response(null, { status: 304, headers: { ETag: object.httpEtag } });
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  }
};
