const [base, alias] = process.argv.slice(2);
if (!base || !alias || !process.env.ADMIN_TOKEN) {
  console.error('Usage: ADMIN_TOKEN=<secret> node scripts/create-link.mjs https://<worker>.workers.dev alias@icloud.com');
  process.exit(2);
}
const response = await fetch(`${base.replace(/\/$/, '')}/admin/aliases`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ alias }),
});
const result = await response.json();
if (!response.ok) { console.error(`Create failed (${response.status}): ${result.error}`); process.exit(1); }
console.log(result.link);
