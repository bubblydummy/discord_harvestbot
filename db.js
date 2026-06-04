const Database = require('better-sqlite3');

const db = new Database('game.db');

db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
        discord_user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        coins INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS rps_stats (
        discord_user_id TEXT PRIMARY KEY,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        champion_wins INTEGER NOT NULL DEFAULT 0,
        best_streak INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (discord_user_id) REFERENCES users(discord_user_id)
    )
`).run();

function ensureUser(user) {
    db.prepare(`
        INSERT OR IGNORE INTO users (discord_user_id, username)
        VALUES (?, ?)
    `).run(user.id, user.username);

    db.prepare(`
        UPDATE users
        SET username = ?
        WHERE discord_user_id = ?
    `).run(user.username, user.id);
}

function addCoins(userId, amount) {
    db.prepare(`
        UPDATE users
        SET coins = coins + ?
        WHERE discord_user_id = ?
    `).run(amount, userId);
}

function getUser(userId) {
    return db.prepare(`
        SELECT *
        FROM users
        WHERE discord_user_id = ?
    `).get(userId);
}


//이 파일 밖에서도 db, ensureUser, addCoins, getUser를 쓸수 있게 내보낸다.
module.exports = {
    db,
    ensureUser,
    addCoins,
    getUser
};