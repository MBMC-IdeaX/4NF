// The Supabase calls the office screens make, answered by the local database.
//
// The Owner, admin and review screens talk to Supabase: sign-in, RPCs, a few
// views, a storage bucket. Testing them against the live project means testing
// against a database that has not had this week's migrations yet, with real
// logins. This answers the same calls from the PGlite database the local sync
// server already runs, with every migration applied.
//
// What makes it a fair test rather than a mock: every call runs in its own
// transaction as the `authenticated` role, with the caller's id in the same JWT
// claim Supabase sets. Row-level security, the grants and every function's own
// checks decide what comes back, exactly as they do in production. The only
// stand-ins are the login itself (a local password table) and the file store
// (a folder on disk, with the bucket's two policies checked by the same SQL
// functions the real policies call).
//
// Never part of a deployed build: src/lib/supabase-local.js is swapped in by
// vite.config.js only when BHADA_LOCAL_DB=1.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

const NAME = /^[a-z_][a-z0-9_]*$/;
const hash = (text) => createHash('sha256').update(String(text)).digest('hex');
const tokenFor = (uid) => `local:${uid}`;
const userFrom = (header) => /^Bearer local:([0-9a-f-]{36})$/.exec(String(header ?? ''))?.[1] ?? null;

export async function prepareLocalAuth(db) {
  await db.query(`
    create table if not exists _local_auth (
      email    text primary key,
      password text not null,
      user_id  uuid not null unique
    )`);
}

// One call as one person, inside a transaction so the role and the claim never
// leak into another request sharing the connection.
async function asUser(db, uid, run) {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [uid ?? '']);
    await tx.query(`set local role ${uid ? 'authenticated' : 'anon'}`);
    return run(tx);
  });
}

async function signUp(db, { email, password }) {
  const address = String(email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(address)) return { error: { message: 'Enter a valid email.' } };
  if (String(password ?? '').length < 8) return { error: { message: 'Password should be at least 8 characters.' } };
  const existing = (await db.query('select user_id from _local_auth where email = $1', [address])).rows[0];
  if (existing) return { error: { message: 'User already registered' } };
  const id = randomUUID();
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, address]);
  await db.query('insert into _local_auth (email, password, user_id) values ($1, $2, $3)', [address, hash(password), id]);
  return { data: sessionFor(id, address) };
}

async function signIn(db, { email, password }) {
  const address = String(email ?? '').trim().toLowerCase();
  const row = (await db.query('select user_id, password from _local_auth where email = $1', [address])).rows[0];
  if (!row || row.password !== hash(password)) return { error: { message: 'Invalid login credentials' } };
  return { data: sessionFor(row.user_id, address) };
}

function sessionFor(id, email) {
  return { session: { access_token: tokenFor(id), user: { id, email } }, user: { id, email } };
}

async function rpc(db, uid, name, args) {
  if (!NAME.test(name)) return { error: { message: 'bad function name' } };
  const keys = Object.keys(args ?? {});
  if (!keys.every((key) => NAME.test(key))) return { error: { message: 'bad argument name' } };
  const list = keys.map((key, i) => `${key} => $${i + 1}`).join(', ');
  try {
    const rows = await asUser(db, uid, (tx) => tx.query(`select ${name}(${list}) as r`, keys.map((key) => args[key])));
    return { data: rows.rows[0]?.r ?? null };
  } catch (error) {
    return { error: { message: error.message } };
  }
}

async function select(db, uid, { table, filters = [], order = [], limit }) {
  if (!NAME.test(table) || table.startsWith('_')) return { error: { message: 'bad table' } };
  const where = [];
  const values = [];
  for (const { col, op, val } of filters) {
    if (!NAME.test(col)) return { error: { message: 'bad column' } };
    const sql = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
    if (!sql) return { error: { message: 'bad operator' } };
    values.push(val);
    where.push(`${col} ${sql} $${values.length}`);
  }
  const by = order.filter((o) => NAME.test(o.col)).map((o) => `${o.col} ${o.asc === false ? 'desc' : 'asc'}`);
  const sql = `select * from ${table}${where.length ? ` where ${where.join(' and ')}` : ''}${by.length ? ` order by ${by.join(', ')}` : ''}${Number.isInteger(limit) ? ` limit ${limit}` : ''}`;
  try {
    const rows = await asUser(db, uid, (tx) => tx.query(sql, values));
    return { data: rows.rows };
  } catch (error) {
    return { error: { message: error.message } };
  }
}

// The storage policies of 0036, asked of the same SQL they call: a company
// writes and reads its own folder, Bhada staff write and read any.
async function mayWrite(db, uid, path) {
  const folder = path.split('/')[0];
  if ((await rpc(db, uid, 'current_operator_id', {})).data === folder) return true;
  return (await rpc(db, uid, 'is_reviewer', {})).data === true;
}
const mayRead = mayWrite;

function filePath(root, bucket, path) {
  const full = normalize(join(root, bucket, path));
  if (!full.startsWith(normalize(join(root, bucket)))) throw new Error('bad path');
  return full;
}

/*
  Routes under /local. Returns [status, body, headers?] or null when the path
  is not one of these.
*/
export async function handleLocalSupabase(db, { method, pathname, search, headers, readJson, readBuffer, filesRoot, origin }) {
  const uid = userFrom(headers.authorization);
  if (method === 'POST' && pathname === '/local/auth/signup') return [200, await signUp(db, await readJson())];
  if (method === 'POST' && pathname === '/local/auth/signin') return [200, await signIn(db, await readJson())];
  if (method === 'POST' && pathname.startsWith('/local/rpc/')) {
    return [200, await rpc(db, uid, pathname.slice('/local/rpc/'.length), await readJson())];
  }
  if (method === 'POST' && pathname === '/local/select') return [200, await select(db, uid, await readJson())];

  if (method === 'POST' && pathname === '/local/storage/upload') {
    const params = new URLSearchParams(search);
    const bucket = params.get('bucket');
    const path = params.get('path') ?? '';
    if (bucket !== 'owner-documents') return [200, { error: { message: 'Bucket not found' } }];
    if (!uid || !(await mayWrite(db, uid, path))) return [200, { error: { message: 'new row violates row-level security policy' } }];
    const target = filePath(filesRoot, bucket, path);
    await mkdir(dirname(target), { recursive: true });
    const exists = await readFile(target).then(() => true, () => false);
    if (exists) return [200, { error: { message: 'The resource already exists' } }];
    await writeFile(target, await readBuffer());
    await writeFile(`${target}.type`, headers['content-type'] ?? 'application/octet-stream');
    return [200, { data: { path } }];
  }
  if (method === 'POST' && pathname === '/local/storage/sign') {
    const { bucket, path } = await readJson();
    if (!uid || !(await mayRead(db, uid, path))) return [200, { error: { message: 'Object not found' } }];
    // The token is the reader's own; the file route checks it again.
    const url = `${origin}/local/storage/file?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}&token=${encodeURIComponent(tokenFor(uid))}`;
    return [200, { data: { signedUrl: url } }];
  }
  if (method === 'GET' && pathname === '/local/storage/file') {
    const params = new URLSearchParams(search);
    const reader = userFrom(`Bearer ${params.get('token')}`);
    const path = params.get('path') ?? '';
    if (!reader || !(await mayRead(db, reader, path))) return [404, { error: 'not found' }];
    const target = filePath(filesRoot, params.get('bucket') ?? '', path);
    const body = await readFile(target).catch(() => null);
    if (!body) return [404, { error: 'not found' }];
    const type = await readFile(`${target}.type`, 'utf8').catch(() => 'application/octet-stream');
    return [200, body, { 'Content-Type': type }];
  }
  return null;
}

// --------------------------------------------------------------- demo logins

export const DEMO_PASSWORD = 'bhada-demo-2026';
export const DEMO_LOGINS = {
  owner: 'owner@demo.bhada.np',
  manager: 'manager@demo.bhada.np',
  conductor: 'conductor@demo.bhada.np',
  rider: 'rider@demo.bhada.np',
  admin: 'admin@demo.bhada.np',
  reviewer: 'reviewer@demo.bhada.np',
  busowner: 'busowner@demo.bhada.np',
};

// Placeholder words for the agreements, so the onboarding screens have
// something to show. The real texts are published by the platform admin.
const DEMO_AGREEMENTS = {
  service: 'Service agreement',
  payout_mandate: 'Payout mandate',
  data_consent: 'Data consent notice',
  membership: 'Bus owner membership',
};

// The smallest file a PDF viewer opens, standing in for a scanned paper.
const DEMO_PDF = '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

/*
  One login for every role and two companies, so every screen has someone to
  sign in as:

    Mayur Yatayat  onboarded the whole way and live: agreements signed (one on
                   paper, two in the app), company papers approved, three buses
                   entered by Bhada, the third owned by a member, a Rs 100 levy
    Nilo Yatayat   just created by Bhada and waiting: nothing signed, no owner

  Run once; running again changes nothing.
*/
export async function seedDemo(db, filesRoot = null) {
  const ids = {};
  for (const [role, email] of Object.entries(DEMO_LOGINS)) {
    const made = await signUp(db, { email, password: DEMO_PASSWORD });
    ids[role] = made.data?.user.id
      ?? (await db.query('select user_id from _local_auth where email = $1', [email])).rows[0].user_id;
  }
  await db.query('insert into platform_admins (user_id) values ($1) on conflict do nothing', [ids.admin]);
  await db.query('insert into platform_reviewers (user_id) values ($1) on conflict do nothing', [ids.reviewer]);

  const done = (await db.query('select operator_id from operator_users where user_id = $1', [ids.owner])).rows[0];
  if (done) return { company: done.operator_id, password: DEMO_PASSWORD, logins: DEMO_LOGINS };

  const as = async (role, name, args = {}) => {
    const { data, error } = await rpc(db, ids[role], name, args);
    if (error || data?.ok === false) throw new Error(`demo seed: ${name} as ${role}: ${error?.message ?? data.reason}`);
    return data;
  };
  const scan = async (path) => {
    if (filesRoot) {
      const target = filePath(filesRoot, 'owner-documents', path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, DEMO_PDF);
      await writeFile(`${target}.type`, 'application/pdf');
    }
    return path;
  };

  for (const [kind, title] of Object.entries(DEMO_AGREEMENTS)) {
    if ((await db.query('select 1 from agreement_texts where kind = $1', [kind])).rows.length) continue;
    await as('admin', 'admin_publish_agreement', {
      p_kind: kind, p_title: title,
      p_body: `${title}. Demo text for local testing only — not the agreement a company signs. The platform admin publishes the real words.`,
    });
  }

  // Mayur: the whole onboarding, in the order Bhada's officer does it.
  const op = (await as('reviewer', 'admin_create_company', {
    p_name: 'Mayur Yatayat', p_contact_name: 'Hari Prasad', p_contact_phone: '9801000001', p_pan: '601111111', p_address: 'Kalanki, Kathmandu',
  })).operator_id;
  await as('reviewer', 'admin_record_agreement', {
    p_operator_id: op, p_kind: 'service', p_version: 1, p_signer_name: 'Hari Prasad', p_signer_phone: '9801000001',
    p_file_path: await scan(`${op}/agreement-service.pdf`),
  });
  const ownerCode = (await as('reviewer', 'admin_invite_owner', { p_operator_id: op, p_label: 'Hari' })).code;
  await as('owner', 'accept_invite', { p_code: ownerCode, p_display_name: 'Hari (owner)' });
  await as('owner', 'accept_agreement', { p_kind: 'payout_mandate', p_version: 1 });
  await as('owner', 'accept_agreement', { p_kind: 'data_consent', p_version: 1 });
  for (const type of ['company_registration', 'pan_vat', 'company_tax_clearance', 'director_citizenship', 'dotm_registration']) {
    const doc = await as('reviewer', 'admin_submit_document', {
      p_operator_id: op, p_doc_type: type, p_plate: null, p_driver_id: null,
      p_file_path: await scan(`${op}/${type}.pdf`), p_file_name: `${type}.pdf`, p_mime_type: 'application/pdf',
    });
    await as('reviewer', 'review_document', { p_id: doc.id, p_decision: 'approved', p_expires_on: type === 'company_tax_clearance' ? '2027-07-16' : null });
  }
  await as('admin', 'admin_set_company_live', { p_operator_id: op });
  await as('reviewer', 'admin_set_levy', { p_operator_id: op, p_amount: 100, p_note: 'From the service agreement' });

  for (const [plate, label, seated, standing] of [['BA2KHA7001', 'Mayur 1', 30, 12], ['BA2KHA7002', 'Mayur 2', 26, 10], ['BA2KHA7003', 'Bikash', 30, 10]]) {
    await as('reviewer', 'admin_register_vehicle', {
      p_operator_id: op, p_plate: plate, p_route_id: 'R11', p_seated: seated, p_standing: standing, p_label: label,
    });
  }
  const manager = await as('owner', 'owner_invite', { p_role: 'manager' });
  await as('manager', 'accept_invite', { p_code: manager.code, p_display_name: 'Sita (manager)' });
  const conductor = await as('owner', 'owner_invite', { p_role: 'conductor', p_plate: 'BA2KHA7001' });
  await as('conductor', 'accept_invite', { p_code: conductor.code, p_display_name: 'Ram (conductor)' });
  const busOwner = await as('owner', 'owner_invite', { p_role: 'bus_owner', p_plate: 'BA2KHA7003', p_label: 'Bikash' });
  await as('busowner', 'accept_invite', { p_code: busOwner.code, p_display_name: 'Bikash (bus owner)' });
  await as('busowner', 'accept_agreement', { p_kind: 'membership', p_version: 1 });
  await as('owner', 'owner_save_driver', { p_name: 'Shyam Thapa', p_license_no: '03-06-41234567', p_phone: '9800000001', p_plate: 'BA2KHA7001' });

  // Nilo: created and waiting, for the staff site to carry through.
  await as('reviewer', 'admin_create_company', {
    p_name: 'Nilo Yatayat', p_contact_name: 'Maya Gurung', p_contact_phone: '9801000002', p_address: 'Lagankhel, Lalitpur',
  });

  return { company: op, password: DEMO_PASSWORD, logins: DEMO_LOGINS };
}
