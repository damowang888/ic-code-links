const utf8 = new TextEncoder();
const noCache = {
  'Cache-Control': 'no-store, private',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function reply(body, status = 200, type = 'application/json; charset=utf-8') {
  return new Response(type.startsWith('application/json') ? JSON.stringify(body) : body,
    { status, headers: { ...noCache, 'Content-Type': type } });
}
function decode64(s) {
  const clean = s.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, '='));
  return Uint8Array.from(bytes, c => c.charCodeAt(0));
}
function encode64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function digest(s) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(s))))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyWebhook(raw, headers, secret, now = Date.now()) {
  const id = headers.get('svix-id') || headers.get('webhook-id');
  const timestamp = headers.get('svix-timestamp') || headers.get('webhook-timestamp');
  const signatures = headers.get('svix-signature') || headers.get('webhook-signature');
  const time = Number(timestamp);
  if (!id || !Number.isSafeInteger(time) || !signatures || !secret?.startsWith('whsec_') ||
      Math.abs(now / 1000 - time) > 300) return false;
  let key;
  try { key = decode64(secret.slice(6)); } catch { return false; }
  const hmac = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, utf8.encode(`${id}.${timestamp}.${raw}`)));
  for (const item of signatures.split(/\s+/)) {
    if (!item.startsWith('v1,')) continue;
    try { if (equalBytes(expected, decode64(item.slice(3)))) return true; } catch { /* invalid signature */ }
  }
  return false;
}

export function extractCode(subject, text) {
  const body = `${subject || ''}\n${text || ''}`.slice(0, 30000);
  const pattern = /(?:verification code|security code|one[- ]time (?:code|password)|验证码|校验码|动态码|otp|code|密码)[^\d]{0,55}(?<!\d)(\d{6})(?!\d)/ig;
  const hit = pattern.exec(body);
  return hit ? hit[1] : null;
}

function addresses(s) {
  return (String(s || '').match(/[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [])
    .map(x => x.toLowerCase());
}
export function routeAlias(email, webhook, registered = new Set()) {
  const headers = Object.fromEntries(Object.entries(email.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const list = value => Array.isArray(value) ? value : [value];
  const fields = [headers.to, headers['x-original-to'], headers['x-forwarded-to'],
    headers['x-icloud-original-to'], ...list(email.to), ...list(webhook.to),
    ...list(email.received_for), ...list(webhook.received_for)];
  const matches = [...new Set(fields.flatMap(addresses).filter(a => a.endsWith('@icloud.com') || registered.has(a)))];
  return matches.length === 1 ? { alias: matches[0], matches } : { alias: null, matches };
}

function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function makePage(alias, rows, publicAddress = false) {
  const items = rows.map(m => `<article><div class="meta">${htmlEscape(m.received_at)} · ${htmlEscape(m.sender)}</div><h2>${htmlEscape(m.subject)}</h2>${m.code ? `<strong class="code">${htmlEscape(m.code)}</strong>` : '<span>未识别到六位验证码</span>'}<p>${htmlEscape(m.snippet)}</p></article>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>取码 · ${htmlEscape(alias)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;background:#f6f7fb;color:#1f2937}h1{font-size:1.3rem;overflow-wrap:anywhere}article{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin:16px 0}h2{font-size:1rem}.meta{color:#667085;font-size:.85rem}.code{font-size:2.3rem;letter-spacing:.14em;display:block;color:#175cd3}p{white-space:pre-wrap;overflow-wrap:anywhere;color:#475467}small{color:#667085}</style><h1>${htmlEscape(alias)}</h1><small>最近邮件 · 每 10 秒自动刷新 · ${publicAddress ? '知道该邮箱地址的人可查看本页' : '链接持有者可查看本页'}</small>${items || '<p>暂未收到邮件。先向隐藏地址发一封测试邮件。</p>'}<script>setTimeout(()=>location.reload(),10000)</script></html>`;
}
const lookupPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>iCloud 邮箱取码</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;background:#f6f7fb;color:#1f2937}section{padding:24px;background:white;border:1px solid #e5e7eb;border-radius:12px}h1{font-size:1.5rem}input{box-sizing:border-box;width:100%;padding:12px;margin:12px 0;border:1px solid #cbd5e1;border-radius:6px}button{padding:11px 20px;background:#175cd3;color:white;border:0;border-radius:6px;cursor:pointer}small{display:block;color:#667085;margin-top:16px}</style><section><h1>iCloud 邮箱取码</h1><p>输入隐藏邮件地址，即可查看收到的验证码。</p><form action="/m" method="get"><label for="email">隐藏邮件地址</label><input id="email" name="e" type="email" required maxlength="254" placeholder="example@icloud.com"><button type="submit">查看验证码</button></form><small>无需登记或生成链接。知道邮箱地址的人可以查看对应验证码。</small></section></html>`;
function authorized(request, env) {
  return env.ADMIN_TOKEN && request.headers.get('Authorization') === `Bearer ${env.ADMIN_TOKEN}`;
}
const adminPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>iCloud 取码管理</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:880px;margin:32px auto;padding:0 20px;background:#f6f7fb;color:#1f2937}section{background:white;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin:16px 0}h1{font-size:1.6rem}h2{font-size:1.1rem}input{box-sizing:border-box;width:100%;padding:11px;border:1px solid #cbd5e1;border-radius:7px;margin:8px 0}button{padding:9px 14px;margin:4px;border:0;border-radius:6px;background:#175cd3;color:white;cursor:pointer}button.danger{background:#b42318}button:disabled{opacity:.5}p,small{color:#667085}#result{overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}td,th{padding:9px;text-align:left;border-bottom:1px solid #e5e7eb;overflow-wrap:anywhere}.scroll{overflow:auto}#status{white-space:pre-wrap;color:#b42318}</style>
<h1>iCloud 取码管理</h1><p>收信自动归类，直接访问 /m?e=隐藏邮件地址 即可取码，无需登记。知道地址的人可查看验证码。</p>
<section><h2>管理认证</h2><label for="key">管理令牌 ADMIN_TOKEN</label><input id="key" type="password" autocomplete="off" placeholder="填写你在 CF Secret 中设置的管理令牌"><button id="connect">连接管理后台</button><small>令牌仅用于当前页面请求，不保存到浏览器。</small></section>
<section><h2>可选私密链接</h2><label for="alias">隐藏邮件地址</label><input id="alias" type="email" placeholder="example@icloud.com"><button id="create">登记并生成私密链接</button><p id="result"></p><small>此项为旧版兼容功能。邮箱参数入口仍可公开访问；重置私密链接不会关闭邮箱参数入口。</small></section>
<section><h2>已收到或登记的地址</h2><button id="refresh">刷新列表</button><div class="scroll"><table><thead><tr><th>邮箱</th><th>创建时间</th><th>操作</th></tr></thead><tbody id="aliases"></tbody></table></div></section>
<section><h2>待处理邮件</h2><p>没有识别出原始隐藏地址，或匹配到多个地址时，邮件留在这里。</p><button id="pending">刷新待处理</button><div id="unmatched"></div></section><p id="status"></p>
<script>
const $=id=>document.getElementById(id);
async function api(path,method='GET',data){const r=await fetch(path,{method,headers:{Authorization:'Bearer '+$('key').value,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined,cache:'no-store'});const v=await r.json();if(!r.ok)throw Error(v.error||'请求失败');return v;}
async function run(fn){$('status').textContent='';try{await fn();}catch(e){$('status').textContent=e.message;}}
function showLink(v){$('result').replaceChildren();const a=document.createElement('a');a.textContent=v.link;a.href=v.link;a.target='_blank';a.rel='noreferrer';$('result').append('请保存：',a);}
async function load(){const v=await api('/admin/aliases');$('aliases').replaceChildren();for(const row of v.aliases){const tr=document.createElement('tr');for(const text of [row.alias,row.created_at]){const td=document.createElement('td');td.textContent=text;tr.append(td);}const td=document.createElement('td');const view=document.createElement('a');view.textContent='取码';view.href='/m?e='+encodeURIComponent(row.alias);view.target='_blank';view.rel='noreferrer';const rotate=document.createElement('button');rotate.textContent='重置私密链接';rotate.onclick=()=>run(async()=>{if(!confirm('旧私密链接会失效，邮箱参数入口仍可访问，继续？'))return;showLink(await api('/admin/rotate','POST',{alias:row.alias}));});const remove=document.createElement('button');remove.textContent='删除';remove.className='danger';remove.onclick=()=>run(async()=>{if(!confirm('删除邮箱登记和缓存邮件，新来信仍会自动归类，继续？'))return;await api('/admin/aliases','DELETE',{alias:row.alias});await load();});td.append(view,rotate,remove);tr.append(td);$('aliases').append(tr);}}
$('connect').onclick=$('refresh').onclick=()=>run(load);
$('create').onclick=()=>run(async()=>{showLink(await api('/admin/aliases','POST',{alias:$('alias').value}));await load();});
$('pending').onclick=()=>run(async()=>{const v=await api('/admin/unmatched');$('unmatched').replaceChildren();for(const m of v.messages){const p=document.createElement('p');p.textContent=m.id+' · '+m.reason+' · '+m.received_at;const button=document.createElement('button');button.textContent='手动归类';button.onclick=()=>run(async()=>{const alias=prompt('先在 Resend 核对这封邮件，再输入所属隐藏地址');if(!alias)return;await api('/admin/assign','POST',{email_id:m.id,alias});p.remove();});p.append(button);$('unmatched').append(p);}if(!v.messages.length)$('unmatched').textContent='没有待处理邮件';});
</script></html>`;
async function getReceivedEmail(env, id) {
  const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
  });
  if (!r.ok) throw new Error(`Resend received email lookup failed: ${r.status}`);
  return r.json();
}
function plainSnippet(email) {
  const plain = email.text || String(email.html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
  return plain.replace(/\s+/g, ' ').slice(0, 240);
}
async function processEmail(env, id, data) {
  const email = await getReceivedEmail(env, id);
  const rows = await env.DB.prepare('SELECT alias FROM aliases').all();
  const { alias, matches } = routeAlias(email, data, new Set(rows.results.map(r => r.alias)));
  if (!alias) {
    await env.DB.prepare('INSERT OR IGNORE INTO unmatched (id, reason, candidates) VALUES (?, ?, ?)')
      .bind(id, matches.length ? '多个别名匹配' : '未发现原始 iCloud 隐藏地址', JSON.stringify(matches)).run();
    return;
  }
  const internalToken = encode64(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT OR IGNORE INTO aliases (alias, token_hash) VALUES (?, ?)')
    .bind(alias, await digest(internalToken)).run();
  const snippet = plainSnippet(email);
  const content = email.text || snippet;
  await env.DB.prepare('INSERT OR IGNORE INTO messages (id, alias, sender, subject, code, snippet) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, alias, String(email.from || data.from || '').slice(0, 250),
      String(email.subject || data.subject || '').slice(0, 250),
      extractCode(email.subject, content), snippet).run();
  await env.DB.prepare('DELETE FROM unmatched WHERE id = ?').bind(id).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/')
      return reply(lookupPage, 200, 'text/html; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/admin')
      return reply(adminPage, 200, 'text/html; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/m') {
      const alias = String(url.searchParams.get('e') || '').trim().toLowerCase();
      if (alias.length > 254 || !/^[a-z0-9.!#$%&'*+\/=\?^_`{|}~-]+@icloud\.com$/i.test(alias))
        return reply({ error: '请输入完整的 iCloud 隐藏邮件地址，例如 example@icloud.com' }, 400);
      if (!env.DB) return reply({ error: 'D1 database is not configured' }, 503);
      let rows;
      try {
        rows = await env.DB.prepare('SELECT sender, subject, code, snippet, received_at FROM messages WHERE alias = ? ORDER BY received_at DESC LIMIT 10').bind(alias).all();
      } catch { return reply({ error: '请先在 D1 Console 执行 schema.sql 初始化数据库' }, 503); }
      if (url.searchParams.get('format') === 'json') return reply({ alias, messages: rows.results });
      return reply(makePage(alias, rows.results, true), 200, 'text/html; charset=utf-8');
    }
    if (request.method === 'POST' && url.pathname === '/webhook/resend') {
      if (!env.WEBHOOK_SECRET || !env.RESEND_API_KEY) return reply({ error: 'Secrets are not configured' }, 503);
      const raw = await request.text();
      if (raw.length > 200000 || !await verifyWebhook(raw, request.headers, env.WEBHOOK_SECRET)) return reply({ error: 'Invalid webhook' }, 401);
      let event;
      try { event = JSON.parse(raw); } catch { return reply({ error: 'Invalid JSON' }, 400); }
      if (event.type === 'email.received' && typeof event.data?.email_id === 'string') {
        try { await processEmail(env, event.data.email_id, event.data); }
        catch { return reply({ error: 'Retry later' }, 503); }
      }
      return reply({ ok: true });
    }
    if (request.method === 'GET' && /^\/m\/[A-Za-z0-9_-]{40,}$/.test(url.pathname)) {
      const token = url.pathname.slice(3);
      const row = await env.DB.prepare('SELECT alias FROM aliases WHERE token_hash = ?').bind(await digest(token)).first();
      if (!row) return reply({ error: 'Link not found' }, 404);
      const rows = await env.DB.prepare('SELECT sender, subject, code, snippet, received_at FROM messages WHERE alias = ? ORDER BY received_at DESC LIMIT 10').bind(row.alias).all();
      if (url.searchParams.get('format') === 'json') return reply({ alias: row.alias, messages: rows.results });
      return reply(makePage(row.alias, rows.results), 200, 'text/html; charset=utf-8');
    }
    if (url.pathname.startsWith('/admin/')) {
      if (!authorized(request, env)) return reply({ error: 'Unauthorized' }, 401);
      if (!env.DB) return reply({ error: '请先在 Cloudflare Bindings 中添加变量名为 DB 的 D1 数据库' }, 503);
      if (request.method === 'GET' && url.pathname === '/admin/aliases') {
        try {
          const rows = await env.DB.prepare('SELECT alias, created_at FROM aliases ORDER BY created_at DESC').all();
          return reply({ aliases: rows.results });
        } catch { return reply({ error: '请先在 D1 Console 执行 schema.sql 初始化数据库' }, 503); }
      }
      if (request.method === 'POST' && url.pathname === '/admin/aliases') {
        let input;
        try { input = await request.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
        const alias = String(input.alias || '').trim().toLowerCase();
        if (!/^[a-z0-9.!#$%&'*+\/=\?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(alias))
          return reply({ error: 'Enter an iCloud hidden email address' }, 400);
        const token = encode64(crypto.getRandomValues(new Uint8Array(32)));
        try { await env.DB.prepare('INSERT INTO aliases (alias, token_hash) VALUES (?, ?)').bind(alias, await digest(token)).run(); }
        catch { return reply({ error: 'Alias already registered' }, 409); }
        return reply({ alias, link: `${url.origin}/m/${token}` }, 201);
      }
      if (request.method === 'POST' && url.pathname === '/admin/rotate') {
        let input;
        try { input = await request.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
        const alias = String(input.alias || '').trim().toLowerCase();
        if (!await env.DB.prepare('SELECT 1 FROM aliases WHERE alias = ?').bind(alias).first()) return reply({ error: 'Unknown alias' }, 404);
        const token = encode64(crypto.getRandomValues(new Uint8Array(32)));
        await env.DB.prepare('UPDATE aliases SET token_hash = ? WHERE alias = ?').bind(await digest(token), alias).run();
        return reply({ alias, link: `${url.origin}/m/${token}` });
      }
      if (request.method === 'DELETE' && url.pathname === '/admin/aliases') {
        let input;
        try { input = await request.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
        const alias = String(input.alias || '').trim().toLowerCase();
        await env.DB.batch([
          env.DB.prepare('DELETE FROM messages WHERE alias = ?').bind(alias),
          env.DB.prepare('DELETE FROM aliases WHERE alias = ?').bind(alias),
        ]);
        return reply({ ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/admin/unmatched') {
        const rows = await env.DB.prepare('SELECT id, reason, candidates, received_at FROM unmatched ORDER BY received_at DESC LIMIT 50').all();
        return reply({ messages: rows.results });
      }
      if (request.method === 'POST' && url.pathname === '/admin/assign') {
        let input;
        try { input = await request.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
        const alias = String(input.alias || '').toLowerCase();
        const id = String(input.email_id || '');
        if (!await env.DB.prepare('SELECT 1 FROM aliases WHERE alias = ?').bind(alias).first() || !/^[\w-]{15,100}$/.test(id)) return reply({ error: 'Unknown alias or email ID' }, 400);
        if (!await env.DB.prepare('SELECT 1 FROM unmatched WHERE id = ?').bind(id).first()) return reply({ error: 'Email is not in unmatched queue' }, 404);
        let email;
        try { email = await getReceivedEmail(env, id); } catch { return reply({ error: 'Could not retrieve email' }, 503); }
        const snippet = plainSnippet(email);
        await env.DB.prepare('INSERT OR IGNORE INTO messages (id, alias, sender, subject, code, snippet) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(id, alias, String(email.from || '').slice(0, 250), String(email.subject || '').slice(0, 250),
            extractCode(email.subject, email.text || snippet), snippet).run();
        await env.DB.prepare('DELETE FROM unmatched WHERE id = ?').bind(id).run();
        return reply({ ok: true });
      }
      return reply({ error: 'Not found' }, 404);
    }
    if (request.method === 'GET' && url.pathname === '/health') return reply({ ok: true });
    return reply({ error: 'Not found' }, 404);
  },
  async scheduled(_event, env) {
    await env.DB.prepare("DELETE FROM messages WHERE received_at < datetime('now', '-7 days')").run();
    await env.DB.prepare("DELETE FROM unmatched WHERE received_at < datetime('now', '-7 days')").run();
  },
};
