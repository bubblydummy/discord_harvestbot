const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const { db } = require('./db');

const {
    DAYS_PER_SEASON,
    seasons,
    cropItems,
    getSeasonIndex
} = require('./farmData');

// 주간 퀘스트 저장 테이블.
// quest_date에는 게임상 주차 키가 들어간다. 예: Y1-W01
db.prepare(`
    CREATE TABLE IF NOT EXISTS daily_quests (
        discord_user_id TEXT NOT NULL,
        quest_date TEXT NOT NULL,
        type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        target INTEGER NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        reward_coins INTEGER NOT NULL DEFAULT 0,
        is_completed INTEGER NOT NULL DEFAULT 0,
        is_claimed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (discord_user_id, quest_date)
    )
`).run();

// 게임상 현재 주차 키를 만든다.
// 예: 게임 1~7일차 = Y1-W01, 8~14일차 = Y1-W02
function getQuestWeek(farm) {
    const seasonIndex = getSeasonIndex(farm.season);

    const totalDays =
        (farm.year - 1) * DAYS_PER_SEASON * seasons.length +
        seasonIndex * DAYS_PER_SEASON +
        (farm.day - 1);

    const week = Math.floor(totalDays / 7) + 1;

    return `Y${farm.year}-W${String(week).padStart(2, '0')}`;
}

// 아이템 ID를 사람이 읽기 쉬운 이름으로 바꾼다.
function getQuestItemName(itemId) {
    if (itemId === 'coin') return '코인';

    if (itemId.endsWith('_seed')) {
        const cropId = itemId.replace('_seed', '');
        const crop = cropItems[cropId];

        return crop ? `${crop.name} 씨앗` : itemId;
    }

    const crop = cropItems[itemId];
    return crop ? crop.name : itemId;
}

// 주간 퀘스트 후보 목록.
// 목표량은 편하게 클리어할 수 있도록 낮게 둔다.
function createWeeklyQuestTemplates() {
    return [
        { type: 'harvest', itemId: 'wheat', target: 5, rewardCoins: 50 },
        { type: 'harvest', itemId: 'potato', target: 3, rewardCoins: 80 },
        { type: 'sell', itemId: 'wheat', target: 5, rewardCoins: 70 },
        { type: 'sell', itemId: 'potato', target: 3, rewardCoins: 100 },
        { type: 'buy', itemId: 'wheat_seed', target: 3, rewardCoins: 30 },
        { type: 'plant', itemId: 'wheat_seed', target: 9, rewardCoins: 40 },
        { type: 'earn', itemId: 'coin', target: 100, rewardCoins: 60 }
    ];
}

function getQuestTypeText(type) {
    const typeText = {
        harvest: '수확하기',
        sell: '판매하기',
        buy: '구매하기',
        plant: '심기',
        earn: '벌기'
    };

    return typeText[type] || type;
}

function pickRandomWeeklyQuest() {
    const templates = createWeeklyQuestTemplates();
    const index = Math.floor(Math.random() * templates.length);

    return templates[index];
}

// 현재 게임 주차의 퀘스트를 가져온다.
function getWeeklyQuest(userId, farm) {
    const questWeek = getQuestWeek(farm);

    return db.prepare(`
        SELECT *
        FROM daily_quests
        WHERE discord_user_id = ?
        AND quest_date = ?
    `).get(userId, questWeek);
}

// 현재 게임 주차의 퀘스트가 없으면 새로 랜덤 생성한다.
function ensureWeeklyQuest(userId, farm) {
    const questWeek = getQuestWeek(farm);
    const existingQuest = getWeeklyQuest(userId, farm);

    if (existingQuest) {
        return existingQuest;
    }

    const quest = pickRandomWeeklyQuest();

    db.prepare(`
        INSERT INTO daily_quests (
            discord_user_id,
            quest_date,
            type,
            item_id,
            target,
            reward_coins
        )
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        userId,
        questWeek,
        quest.type,
        quest.itemId,
        quest.target,
        quest.rewardCoins
    );

    return getWeeklyQuest(userId, farm);
}

// 행동이 현재 퀘스트 조건과 맞으면 진행도를 올린다.
function addWeeklyQuestProgress(userId, farm, type, itemId, amount) {
    const quest = ensureWeeklyQuest(userId, farm);

    if (!quest) return;
    if (quest.is_completed === 1) return;
    if (quest.type !== type) return;
    if (quest.item_id !== itemId) return;

    const newProgress = Math.min(quest.target, quest.progress + amount);
    const isCompleted = newProgress >= quest.target ? 1 : 0;

    db.prepare(`
        UPDATE daily_quests
        SET progress = ?,
            is_completed = ?
        WHERE discord_user_id = ?
        AND quest_date = ?
    `).run(newProgress, isCompleted, userId, quest.quest_date);
}

// 퀘스트 패널에 표시할 문구를 만든다.
function createWeeklyQuestText(userId, farm) {
    const quest = ensureWeeklyQuest(userId, farm);
    const itemName = getQuestItemName(quest.item_id);
    const typeText = getQuestTypeText(quest.type);

    const status = quest.is_completed === 1
        ? quest.is_claimed === 1
            ? '보상 수령 완료'
            : '완료! 보상을 받을 수 있습니다.'
        : '진행 중';

    return [
        '이번 주 퀘스트',
        `기간: ${quest.quest_date}`,
        `${itemName} ${quest.target}개 ${typeText}`,
        `진행도: ${quest.progress}/${quest.target}`,
        `보상: ${quest.reward_coins}G`,
        `상태: ${status}`
    ].join('\n');
}

// 퀘스트 패널의 버튼 줄을 만든다.
function createWeeklyQuestRows(quest) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('farm_weekly_quest_claim')
                .setLabel('보상 받기')
                .setStyle(ButtonStyle.Success)
                .setDisabled(!(quest.is_completed === 1 && quest.is_claimed === 0))
        )
    ];
}

// 퀘스트 완료 보상을 지급한다.
function claimWeeklyQuestReward(userId, farm) {
    const quest = getWeeklyQuest(userId, farm);

    if (!quest) {
        return { success: false, message: '이번 주 퀘스트가 없습니다.' };
    }

    if (quest.is_completed !== 1) {
        return { success: false, message: '아직 퀘스트가 완료되지 않았습니다.' };
    }

    if (quest.is_claimed === 1) {
        return { success: false, message: '이미 보상을 받았습니다.' };
    }

    db.prepare(`
        UPDATE users
        SET coins = coins + ?
        WHERE discord_user_id = ?
    `).run(quest.reward_coins, userId);

    db.prepare(`
        UPDATE daily_quests
        SET is_claimed = 1
        WHERE discord_user_id = ?
        AND quest_date = ?
    `).run(userId, quest.quest_date);

    return {
        success: true,
        message: `퀘스트 보상 ${quest.reward_coins}G를 받았습니다.`
    };
}

module.exports = {
    ensureWeeklyQuest,
    getWeeklyQuest,
    addWeeklyQuestProgress,
    createWeeklyQuestText,
    createWeeklyQuestRows,
    claimWeeklyQuestReward
};