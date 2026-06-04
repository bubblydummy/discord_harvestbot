 //통계 테이블과 통계 기록 함수만 따로 빼는 것

 const { db } = require('./db');

// 유저별 아이템 통계를 저장하는 테이블을 만든다.
// 이미 있으면 새로 만들지 않는다.
db.prepare(`
    CREATE TABLE IF NOT EXISTS farm_item_stats (
        discord_user_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        harvested INTEGER NOT NULL DEFAULT 0,
        sold INTEGER NOT NULL DEFAULT 0,
        bought INTEGER NOT NULL DEFAULT 0,
        planted INTEGER NOT NULL DEFAULT 0,
        earned INTEGER NOT NULL DEFAULT 0,
        spent INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (discord_user_id, item_id)
    )
`).run();

// 유저의 특정 아이템 통계를 amount만큼 증가시킨다.
// field는 harvested, sold, bought, planted, earned, spent 중 하나만 허용한다.
function recordItemStat(userId, itemId, field, amount) {
    const allowedFields = [
        'harvested',
        'sold',
        'bought',
        'planted',
        'earned',
        'spent'
    ];

    if (!allowedFields.includes(field)) {
        throw new Error(`Invalid stat field: ${field}`);
    }

    // 해당 유저 + 아이템 통계 줄이 없으면 먼저 만든다.
    // 이미 있으면 INSERT는 무시된다.
    db.prepare(`
        INSERT OR IGNORE INTO farm_item_stats (discord_user_id, item_id)
        VALUES (?, ?)
    `).run(userId, itemId);

    // 해당 통계값을 증가시킨다.
    db.prepare(`
        UPDATE farm_item_stats
        SET ${field} = ${field} + ?
        WHERE discord_user_id = ?
        AND item_id = ?
    `).run(amount, userId, itemId);
}

module.exports = {
    recordItemStat
};