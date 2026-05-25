export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  /* 路径: /api/thingmodel/... → OneNET /thingmodel/... */
  const apiPath = url.pathname.replace(/^\/api/, '') + url.search;

  const headers = new Headers();
  const auth = request.headers.get('Authorization');
  if (auth) headers.set('Authorization', auth);
  if (request.method === 'POST' || request.method === 'PUT') {
    headers.set('Content-Type', 'application/json');
  }

  const init = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.text();
  }

  const res = await fetch('https://iot-api.heclouds.com' + apiPath, init);
  const resHeaders = new Headers(res.headers);
  resHeaders.set('Access-Control-Allow-Origin', '*');

  return new Response(res.body, { status: res.status, headers: resHeaders });
}
