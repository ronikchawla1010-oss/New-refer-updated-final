import pg from "pg";

const { Pool } = pg;
type QueryResultRow = Record<string, unknown>;

let pool: pg.Pool | undefined;

function database() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    pool = new Pool({
      connectionString: url,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on("error", (error) => console.error("postgres pool error", error));
  }
  return pool;
}

export async function withTransaction<T>(
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function initDatabase() {
  const db = database();
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT NOT NULL DEFAULT '',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      onboarding_status TEXT NOT NULL DEFAULT 'new',
      disclaimer_accepted BOOLEAN NOT NULL DEFAULT FALSE,
      banned BOOLEAN NOT NULL DEFAULT FALSE,
      points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
      referred_by BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS referrals (
      referrer_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      referred_user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals(referrer_id);
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      required_points INTEGER NOT NULL CHECK (required_points >= 0),
      how_to_use TEXT NOT NULL DEFAULT '',
       sort_order INTEGER NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE products ADD COLUMN IF NOT EXISTS how_to_use TEXT NOT NULL DEFAULT '';
     ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
     UPDATE products
     SET sort_order = ranked.position
     FROM (
       SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) - 1 AS position
       FROM products
     ) AS ranked
     WHERE products.id = ranked.id
       AND NOT EXISTS (SELECT 1 FROM products WHERE sort_order <> 0);
    CREATE TABLE IF NOT EXISTS coupons (
      id BIGSERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      claimed_by BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
      claimed_at TIMESTAMPTZ
    );
     ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_product_id_code_key;
    CREATE INDEX IF NOT EXISTS coupons_stock_idx ON coupons(product_id, status);
    CREATE TABLE IF NOT EXISTS milestones (
      id SERIAL PRIMARY KEY,
      required_valid_referrals INTEGER NOT NULL CHECK (required_valid_referrals > 0),
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(required_valid_referrals, product_id)
    );
    CREATE TABLE IF NOT EXISTS rewards (
      user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'unlocked',
      unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      PRIMARY KEY(user_id, milestone_id)
    );
    CREATE TABLE IF NOT EXISTS claims (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      coupon_id BIGINT NOT NULL UNIQUE REFERENCES coupons(id) ON DELETE RESTRICT,
      milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
      points_charged INTEGER NOT NULL DEFAULT 0 CHECK (points_charged >= 0),
      status TEXT NOT NULL DEFAULT 'reserved',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ,
      UNIQUE(user_id, product_id)
    );
    ALTER TABLE claims ADD COLUMN IF NOT EXISTS points_charged INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_user_id_product_id_key;
    CREATE INDEX IF NOT EXISTS claims_user_idx ON claims(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS admins (
      telegram_id BIGINT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'admin',
      added_by BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS force_channels (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      invite_link TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      admin_id BIGINT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);
    CREATE TABLE IF NOT EXISTS broadcast_jobs (
      id BIGSERIAL PRIMARY KEY,
      source_chat_id BIGINT NOT NULL,
      source_message_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      last_user_id BIGINT,
      sent INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );
  `);
  await db.query(
    `INSERT INTO settings(key,value,enabled) VALUES
      ('welcome','✨ 𝗪𝗲𝗹𝗰𝗼𝗺𝗲 𝘁𝗼 Free Coupon Hub!\\n\\nInvite your friends, complete referral milestones, and unlock exciting free rewards. 🎁\\n\\nStart sharing your link and unlock your next reward! 🚀','true'),
      ('disclaimer','⚠️ IMPORTANT WARNING: Rewards are added to the bot in bulk, so occasionally you may receive a duplicate, expired, already-used, invalid, or non-working reward. If you receive only 1–2 such rewards, please do not contact Support, as minor issues can happen during bulk distribution. However, if you repeatedly receive the same issue across multiple rewards, you may contact the Support Bot and an admin will review the situation and assist where possible. By clicking Accept & Continue, you confirm that you understand and accept these terms.','true'),
      ('support_username','SupportBot','true'),
      ('support_message','For help, contact our Support Bot.','true'),
      ('maintenance_message','🛠️ The bot is temporarily under maintenance. Please try again later.','true'),
      ('referrals_enabled','true','true'),
      ('referral_points','1','true')
    ON CONFLICT(key) DO NOTHING`,
  );
  const owner = Number(process.env.OWNER_ID);
  if (Number.isSafeInteger(owner) && owner > 0) {
    await db.query(
      `INSERT INTO admins(telegram_id,role) VALUES($1,'owner') ON CONFLICT(telegram_id) DO UPDATE SET role='owner'`,
      [owner],
    );
  }
}

export async function takePollingLock() {
  const client = await database().connect();
  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(871426031) AS locked",
  );
  if (!result.rows[0]?.locked) {
    client.release();
    throw new Error("Another bot instance already owns the polling lock");
  }
  return client;
}

export async function getSetting(key: string, fallback = "") {
  const result = await database().query<{ value: string; enabled: boolean }>(
    "SELECT value, enabled FROM settings WHERE key=$1",
    [key],
  );
  return result.rows[0]?.enabled === false ? fallback : result.rows[0]?.value ?? fallback;
}

export async function setSetting(key: string, value: string, enabled = true) {
  await database().query(
    `INSERT INTO settings(key,value,enabled,updated_at) VALUES($1,$2,$3,NOW())
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,enabled=EXCLUDED.enabled,updated_at=NOW()`,
    [key, value, enabled],
  );
}

export async function isAdmin(id: number) {
  const owner = Number(process.env.OWNER_ID);
  if (id === owner && owner > 0) return true;
  const result = await database().query("SELECT 1 FROM admins WHERE telegram_id=$1", [id]);
  return result.rowCount === 1;
}

export async function isOwner(id: number) {
  return Number(process.env.OWNER_ID) === id && id > 0;
}

export async function upsertUser(user: {
  id: number;
  username?: string;
  firstName?: string;
  referrerId?: number;
}) {
  return withTransaction(async (client) => {
    const existing = await client.query<{ telegram_id: string; onboarding_status: string }>(
      "SELECT telegram_id,onboarding_status FROM users WHERE telegram_id=$1 FOR UPDATE",
      [user.id],
    );
    if (existing.rowCount) {
      await client.query(
        "UPDATE users SET username=$2,first_name=$3,updated_at=NOW() WHERE telegram_id=$1",
        [user.id, user.username ?? null, user.firstName ?? ""],
      );
      return { isNew: false, status: existing.rows[0].onboarding_status };
    }
    let referrer: number | undefined;
    if (user.referrerId && user.referrerId !== user.id) {
      const ref = await client.query<{ telegram_id: string }>(
        "SELECT telegram_id FROM users WHERE telegram_id=$1",
        [user.referrerId],
      );
      if (ref.rowCount) referrer = user.referrerId;
    }
    await client.query(
      `INSERT INTO users(telegram_id,username,first_name,referred_by)
       VALUES($1,$2,$3,$4)`,
      [user.id, user.username ?? null, user.firstName ?? "", referrer ?? null],
    );
    if (referrer) {
      await client.query(
        `INSERT INTO referrals(referrer_id,referred_user_id,status)
         VALUES($1,$2,'pending') ON CONFLICT(referred_user_id) DO NOTHING`,
        [referrer, user.id],
      );
    }
    return { isNew: true, status: "new", referrerId: referrer };
  });
}

export async function userById(id: number) {
  const result = await database().query<QueryResultRow>(
    "SELECT * FROM users WHERE telegram_id=$1",
    [id],
  );
  return result.rows[0] as (QueryResultRow & { telegram_id: string }) | undefined;
}

export async function markStatus(id: number, status: string, disclaimer = false) {
  await database().query(
    `UPDATE users SET onboarding_status=$2,disclaimer_accepted=CASE WHEN $3 THEN TRUE ELSE disclaimer_accepted END,updated_at=NOW()
     WHERE telegram_id=$1`,
    [id, status, disclaimer],
  );
}

export async function completeReferral(referredUserId: number) {
  return withTransaction(async (client) => {
    const pending = await client.query<{ referrer_id: string }>(
      `SELECT referrer_id FROM referrals WHERE referred_user_id=$1 AND status='pending' FOR UPDATE`,
      [referredUserId],
    );
    if (!pending.rowCount) return undefined;
    const referrerId = Number(pending.rows[0].referrer_id);
    await client.query(
      "UPDATE referrals SET status='completed',completed_at=NOW() WHERE referred_user_id=$1",
      [referredUserId],
    );
    const setting = await client.query<{ value: string }>(
      "SELECT value FROM settings WHERE key='referral_points' AND enabled=TRUE",
    );
    const configuredPoints = Number(setting.rows[0]?.value);
    const points = Number.isSafeInteger(configuredPoints) && configuredPoints >= 0 ? configuredPoints : 1;
    await client.query("UPDATE users SET points=points+$2,updated_at=NOW() WHERE telegram_id=$1", [
      referrerId,
      points,
    ]);
    const totals = await client.query<{ total: string; valid: string; pending: string }>(
      `SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER(WHERE status='completed')::int AS valid,
        COUNT(*) FILTER(WHERE status='pending')::int AS pending
       FROM referrals WHERE referrer_id=$1`,
      [referrerId],
    );
    return { referrerId, ...totals.rows[0] };
  });
}

export async function referralStats(id: number) {
  const result = await database().query<{ total: string; valid: string; pending: string }>(
    `SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER(WHERE status='completed')::int AS valid,
      COUNT(*) FILTER(WHERE status='pending')::int AS pending
     FROM referrals WHERE referrer_id=$1`,
    [id],
  );
  return result.rows[0] ?? { total: "0", valid: "0", pending: "0" };
}

export async function channels() {
  const result = await database().query<QueryResultRow>(
    "SELECT * FROM force_channels WHERE enabled=TRUE ORDER BY sort_order,id",
  );
  return result.rows;
}

export async function allChannels() {
  const result = await database().query<QueryResultRow>(
    "SELECT * FROM force_channels ORDER BY sort_order,id",
  );
  return result.rows;
}

export async function products(_page = 0, _limit = 6) {
  const result = await database().query<QueryResultRow>(
    `SELECT p.*,COUNT(c.id) FILTER(WHERE c.status='available')::int AS stock
     FROM products p LEFT JOIN coupons c ON c.product_id=p.id
     GROUP BY p.id ORDER BY p.sort_order ASC,p.id ASC`,
  );
  return result.rows;
}

export async function product(id: number) {
  const result = await database().query<QueryResultRow>(
    `SELECT p.*,COUNT(c.id) FILTER(WHERE c.status='available')::int AS stock
     FROM products p LEFT JOIN coupons c ON c.product_id=p.id WHERE p.id=$1 GROUP BY p.id`,
    [id],
  );
  return result.rows[0];
}

export async function addProduct(name: string, points: number, howToUse: string, code: string) {
  return withTransaction(async (client) => {
    const created = await client.query<{ id: number }>(
      `INSERT INTO products(name,required_points,how_to_use,sort_order)
       SELECT $1,$2,$3,COALESCE(MAX(sort_order),-1)+1 FROM products
       RETURNING id`,
      [name, points, howToUse],
    );
    await client.query("INSERT INTO coupons(product_id,code) VALUES($1,$2)", [created.rows[0].id, code]);
    return created.rows[0].id;
  });
}

export async function addStock(productId: number, code: string) {
  return withTransaction(async (client) => {
    await client.query("INSERT INTO coupons(product_id,code) VALUES($1,$2)", [productId, code]);
    const result = await client.query<{ stock: string }>(
      "SELECT COUNT(*)::int AS stock FROM coupons WHERE product_id=$1 AND status='available'",
      [productId],
    );
    return Number(result.rows[0].stock);
  });
}

export async function addStockBulk(productId: number, codes: string[]) {
  return withTransaction(async (client) => {
    for (const code of codes) {
      await client.query("INSERT INTO coupons(product_id,code) VALUES($1,$2)", [productId, code]);
    }
    const result = await client.query<{ stock: string }>(
      "SELECT COUNT(*)::int AS stock FROM coupons WHERE product_id=$1 AND status='available'",
      [productId],
    );
    return { added: codes.length, stock: Number(result.rows[0].stock) };
  });
}

export async function moveProduct(id: number, direction: "up" | "down") {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: number }>(
      "SELECT id FROM products ORDER BY sort_order ASC,id ASC",
    );
    const order = result.rows.map((row) => Number(row.id));
    const currentIndex = order.indexOf(id);
    const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= order.length) return false;
    [order[currentIndex], order[nextIndex]] = [order[nextIndex], order[currentIndex]];
    for (const [position, productId] of order.entries()) {
      await client.query("UPDATE products SET sort_order=$2 WHERE id=$1", [productId, position]);
    }
    return true;
  });
}

export async function setProduct(
  id: number,
  patch: { name?: string; points?: number; howToUse?: string; enabled?: boolean },
) {
  await database().query(
    `UPDATE products SET name=COALESCE($2,name),required_points=COALESCE($3,required_points),
     how_to_use=COALESCE($4,how_to_use),enabled=COALESCE($5,enabled) WHERE id=$1`,
    [id, patch.name ?? null, patch.points ?? null, patch.howToUse ?? null, patch.enabled ?? null],
  );
}

export async function deleteProduct(id: number) {
  await database().query("DELETE FROM products WHERE id=$1", [id]);
}

export async function milestones() {
  const result = await database().query<QueryResultRow>(
    `SELECT m.*,p.name AS product_name FROM milestones m JOIN products p ON p.id=m.product_id ORDER BY m.required_valid_referrals`,
  );
  return result.rows;
}

export async function addMilestone(required: number, productId: number) {
  const result = await database().query<{ id: number }>(
    `INSERT INTO milestones(required_valid_referrals,product_id)
     VALUES($1,$2) ON CONFLICT(required_valid_referrals,product_id) DO UPDATE SET enabled=TRUE RETURNING id`,
    [required, productId],
  );
  return result.rows[0].id;
}

export async function setMilestone(id: number, enabled: boolean) {
  await database().query("UPDATE milestones SET enabled=$2 WHERE id=$1", [id, enabled]);
}

export async function unlockMilestones(userId: number) {
  return withTransaction(async (client) => {
    const count = await client.query<{ valid: string }>(
      "SELECT COUNT(*)::int AS valid FROM referrals WHERE referrer_id=$1 AND status='completed'",
      [userId],
    );
    const rows = await client.query<QueryResultRow>(
      `SELECT m.id,m.required_valid_referrals,m.product_id,p.name AS product_name
       FROM milestones m JOIN products p ON p.id=m.product_id
       WHERE m.enabled=TRUE AND m.required_valid_referrals <= $1 ORDER BY m.required_valid_referrals`,
      [Number(count.rows[0].valid)],
    );
    const fresh: QueryResultRow[] = [];
    for (const row of rows.rows) {
      const inserted = await client.query(
        `INSERT INTO rewards(user_id,milestone_id,product_id) VALUES($1,$2,$3)
         ON CONFLICT(user_id,milestone_id) DO NOTHING RETURNING milestone_id`,
        [userId, row.id, row.product_id],
      );
      if (inserted.rowCount) fresh.push(row);
    }
    return fresh;
  });
}

export async function rewards(userId: number) {
  const result = await database().query<QueryResultRow>(
    `SELECT r.*,m.required_valid_referrals,p.name AS product_name,
      COUNT(c.id) FILTER(WHERE c.status='available')::int AS stock
     FROM rewards r JOIN milestones m ON m.id=r.milestone_id
     JOIN products p ON p.id=r.product_id LEFT JOIN coupons c ON c.product_id=r.product_id
     WHERE r.user_id=$1 GROUP BY r.user_id,r.milestone_id,m.id,p.id ORDER BY m.required_valid_referrals`,
    [userId],
  );
  return result.rows;
}

export async function reserveCoupon(userId: number, productId: number, milestoneId?: number) {
  return withTransaction(async (client) => {
    const u = await client.query<{ points: number; banned: boolean }>(
      "SELECT points,banned FROM users WHERE telegram_id=$1 FOR UPDATE",
      [userId],
    );
    if (!u.rowCount || u.rows[0].banned) return { error: "banned" as const };
    const p = await client.query<{ required_points: number; how_to_use: string; enabled: boolean }>(
      "SELECT required_points,how_to_use,enabled FROM products WHERE id=$1 FOR UPDATE",
      [productId],
    );
    if (!p.rowCount || !p.rows[0].enabled) return { error: "unavailable" as const };
    if (Number(u.rows[0].points) < Number(p.rows[0].required_points)) return { error: "points" as const };
    if (milestoneId) {
      const reward = await client.query(
        "SELECT 1 FROM rewards WHERE user_id=$1 AND milestone_id=$2 AND status='unlocked' FOR UPDATE",
        [userId, milestoneId],
      );
      if (!reward.rowCount) return { error: "locked" as const };
    }
    await client.query("DELETE FROM claims WHERE user_id=$1 AND product_id=$2 AND status='failed'", [
      userId,
      productId,
    ]);
    const coupon = await client.query<{ id: string; code: string }>(
      `SELECT id,code FROM coupons WHERE product_id=$1 AND status='available'
       ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [productId],
    );
    if (!coupon.rowCount) return { error: "stock" as const };
    const charged = await client.query(
      `UPDATE users
       SET points=points-$2,updated_at=NOW()
       WHERE telegram_id=$1 AND points >= $2
       RETURNING points`,
      [userId, Number(p.rows[0].required_points)],
    );
    if (!charged.rowCount) return { error: "points" as const };
    const claim = await client.query<{ id: string }>(
      `INSERT INTO claims(user_id,product_id,coupon_id,milestone_id,points_charged,status)
       VALUES($1,$2,$3,$4,$5,'reserved') RETURNING id`,
      [userId, productId, coupon.rows[0].id, milestoneId ?? null, Number(p.rows[0].required_points)],
    );
    await client.query(
      "UPDATE coupons SET status='reserved',claimed_by=$2,claimed_at=NOW() WHERE id=$1",
      [coupon.rows[0].id, userId],
    );
    return {
      claimId: Number(claim.rows[0].id),
      code: coupon.rows[0].code,
      howToUse: p.rows[0].how_to_use,
    };
  });
}

export async function finishClaim(claimId: number, success: boolean, error?: string) {
  return withTransaction(async (client) => {
    const claim = await client.query<{ coupon_id: string; user_id: string; milestone_id: number | null }>(
      "SELECT coupon_id,user_id,milestone_id FROM claims WHERE id=$1 FOR UPDATE",
      [claimId],
    );
    if (!claim.rowCount) return;
    if (success) {
      const delivered = await client.query(
        "UPDATE claims SET status='delivered',delivered_at=NOW() WHERE id=$1 AND status='reserved' RETURNING id",
        [claimId],
      );
      if (!delivered.rowCount) return;
      if (claim.rows[0].milestone_id) {
        await client.query(
          "UPDATE rewards SET status='claimed',claimed_at=NOW() WHERE user_id=$1 AND milestone_id=$2",
          [claim.rows[0].user_id, claim.rows[0].milestone_id],
        );
      }
      await client.query("UPDATE coupons SET status='claimed',claimed_at=NOW() WHERE id=$1", [
        claim.rows[0].coupon_id,
      ]);
    } else {
      const failed = await client.query<{ points_charged: number }>(
        "UPDATE claims SET status='failed',error=$2 WHERE id=$1 AND status='reserved' RETURNING points_charged",
        [claimId, error?.slice(0, 500) ?? "delivery failed"],
      );
      if (!failed.rowCount) return;
      await client.query(
        "UPDATE users SET points=points+$2,updated_at=NOW() WHERE telegram_id=$1",
        [claim.rows[0].user_id, Number(failed.rows[0].points_charged)],
      );
      await client.query("UPDATE claims SET points_charged=0 WHERE id=$1", [claimId]);
      await client.query(
        "UPDATE coupons SET status='available',claimed_by=NULL,claimed_at=NULL WHERE id=$1 AND status='reserved'",
        [claim.rows[0].coupon_id],
      );
    }
  });
}

export async function releaseStaleClaims() {
  return withTransaction(async (client) => {
    const stale = await client.query<{ id: string; user_id: string; coupon_id: string; points_charged: number }>(
      `SELECT id,user_id,coupon_id,points_charged
       FROM claims
       WHERE status='reserved' AND created_at < NOW()-INTERVAL '15 minutes'
       FOR UPDATE SKIP LOCKED`,
    );
    for (const claim of stale.rows) {
      const failed = await client.query(
        "UPDATE claims SET status='failed',error='reservation expired',points_charged=0 WHERE id=$1 AND status='reserved' RETURNING id",
        [claim.id],
      );
      if (!failed.rowCount) continue;
      await client.query(
        "UPDATE users SET points=points+$2,updated_at=NOW() WHERE telegram_id=$1",
        [claim.user_id, Number(claim.points_charged)],
      );
      await client.query(
        "UPDATE coupons SET status='available',claimed_by=NULL,claimed_at=NULL WHERE id=$1 AND status='reserved'",
        [claim.coupon_id],
      );
    }
  });
}

export async function profile(id: number) {
  const user = await userById(id);
  const stats = await referralStats(id);
  const rewardRows = await rewards(id);
  return { user, stats, rewards: rewardRows };
}

export async function audit(adminId: number, action: string, target = "", details = "") {
  await database().query(
    "INSERT INTO audit_logs(admin_id,action,target,details) VALUES($1,$2,$3,$4)",
    [adminId, action, target, details],
  );
}

export async function auditRows(limit = 12, offset = 0) {
  const result = await database().query<QueryResultRow>(
    `SELECT admin_id,action,target,details,created_at
     FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}

export async function dashboard() {
  const result = await database().query<QueryResultRow>(`
    SELECT
      (SELECT COUNT(*)::int FROM users) AS total_users,
      (SELECT COUNT(*)::int FROM users WHERE onboarding_status='completed' AND banned=FALSE) AS active_users,
      (SELECT COUNT(*)::int FROM users WHERE joined_at > NOW()-INTERVAL '24 hours') AS new_users,
      (SELECT COUNT(*)::int FROM users WHERE banned=TRUE) AS banned_users,
      (SELECT COUNT(*)::int FROM referrals) AS total_referrals,
      (SELECT COUNT(*)::int FROM referrals WHERE status='completed') AS valid_referrals,
      (SELECT COUNT(*)::int FROM referrals WHERE status='pending') AS pending_referrals,
      (SELECT COUNT(*)::int FROM products) AS products,
      (SELECT COUNT(*)::int FROM coupons WHERE status='available') AS stock,
      (SELECT COUNT(*)::int FROM claims WHERE status='delivered') AS claims,
      (SELECT COUNT(*)::int FROM claims WHERE status='failed') AS failed_claims
  `);
  return result.rows[0];
}

export async function adminProducts() {
  const result = await database().query<QueryResultRow>(
    `SELECT p.*,COUNT(c.id) FILTER(WHERE c.status='available')::int AS stock
     FROM products p LEFT JOIN coupons c ON c.product_id=p.id GROUP BY p.id ORDER BY p.sort_order ASC,p.id ASC`,
  );
  return result.rows;
}

export async function adminList() {
  const result = await database().query<QueryResultRow>(
    "SELECT telegram_id,role,created_at FROM admins ORDER BY created_at",
  );
  return result.rows;
}

export async function addAdmin(id: number, by: number) {
  const result = await database().query(
    "INSERT INTO admins(telegram_id,role,added_by) VALUES($1,'admin',$2) ON CONFLICT DO NOTHING",
    [id, by],
  );
  return result.rowCount === 1;
}

export async function removeAdmin(id: number) {
  const result = await database().query("DELETE FROM admins WHERE telegram_id=$1 AND role <> 'owner'", [id]);
  return result.rowCount === 1;
}

export async function addChannel(chatId: string, title: string, link: string) {
  await database().query(
    `INSERT INTO force_channels(chat_id,title,invite_link) VALUES($1,$2,$3)
     ON CONFLICT(chat_id) DO UPDATE SET title=EXCLUDED.title,invite_link=EXCLUDED.invite_link,enabled=TRUE`,
    [chatId, title, link],
  );
}

export async function removeChannel(id: number) {
  await database().query("DELETE FROM force_channels WHERE id=$1", [id]);
}

export async function userRows(limit = 20) {
  const result = await database().query<QueryResultRow>(
    "SELECT telegram_id,username,first_name,points,banned,onboarding_status,joined_at FROM users ORDER BY joined_at DESC LIMIT $1",
    [limit],
  );
  return result.rows;
}

export async function adjustUser(id: number, pointsDelta: number, ban?: boolean) {
  await database().query(
    `UPDATE users SET points=GREATEST(0,points+$2),banned=COALESCE($3,banned),updated_at=NOW() WHERE telegram_id=$1`,
    [id, pointsDelta, ban ?? null],
  );
}

export async function adjustPoints(id: number, pointsDelta: number) {
  const result = await database().query<{ points: number }>(
    `UPDATE users
     SET points=GREATEST(0,points+$2),updated_at=NOW()
     WHERE telegram_id=$1
     RETURNING points`,
    [id, pointsDelta],
  );
  return result.rows[0]?.points ?? null;
}

export async function createBroadcast(chatId: number, messageId: number) {
  const result = await database().query<{ id: string }>(
    "INSERT INTO broadcast_jobs(source_chat_id,source_message_id,status) VALUES($1,$2,'draft') RETURNING id",
    [chatId, messageId],
  );
  return Number(result.rows[0].id);
}

export async function setBroadcastStatus(id: number, status: string) {
  await database().query(
    "UPDATE broadcast_jobs SET status=$2,finished_at=CASE WHEN $2='done' THEN NOW() ELSE finished_at END WHERE id=$1",
    [id, status],
  );
}

export async function broadcastJob(id: number) {
  const result = await database().query<QueryResultRow>(
    "SELECT * FROM broadcast_jobs WHERE id=$1",
    [id],
  );
  return result.rows[0];
}

export async function broadcastProgress(id: number, userId: number, sent: number, failed: number) {
  await database().query(
    "UPDATE broadcast_jobs SET last_user_id=$2,sent=$3,failed=$4 WHERE id=$1",
    [id, userId, sent, failed],
  );
}

export async function pendingBroadcasts() {
  const result = await database().query<QueryResultRow>(
    "SELECT * FROM broadcast_jobs WHERE status='sending' ORDER BY id",
  );
  return result.rows;
}

export async function broadcastUsers(after = 0) {
  const result = await database().query<{ telegram_id: string }>(
    "SELECT telegram_id FROM users WHERE banned=FALSE AND onboarding_status='completed' AND telegram_id>$1 ORDER BY telegram_id",
    [after],
  );
  return result.rows.map((row) => Number(row.telegram_id));
}