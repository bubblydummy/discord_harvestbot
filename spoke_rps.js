const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const { db, ensureUser, addCoins } = require('./db');

const choices = ['가위', '바위', '보'];

let rpsGame = {
    active: false,
    waitingForResetConfirm: false,
    resetRequesterId: null
};

db.prepare(`
    CREATE TABLE IF NOT EXISTS rps_participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL,
        is_alive INTEGER NOT NULL DEFAULT 1,
        current_streak INTEGER NOT NULL DEFAULT 0,
        best_streak INTEGER NOT NULL DEFAULT 0,
        joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS rps_stats (
        discord_user_id TEXT PRIMARY KEY,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        champion_wins INTEGER NOT NULL DEFAULT 0,
        best_streak INTEGER NOT NULL DEFAULT 0
    )
`).run();

// 봇이 가위, 바위, 보 중 하나를 랜덤으로 고른다.
function getBotChoice() {
    return choices[Math.floor(Math.random() * choices.length)];
}

// 유저 선택과 봇 선택을 비교해서 win, lose, draw 중 하나를 반환한다.
function getResult(userChoice, botChoice) {
    if (userChoice === botChoice) return 'draw';

    if (
        (userChoice === '가위' && botChoice === '보') ||
        (userChoice === '바위' && botChoice === '가위') ||
        (userChoice === '보' && botChoice === '바위')
    ) {
        return 'win';
    }

    return 'lose';
}

// 이전 게임 참가자 기록이 rps_participants 테이블에 남아있는지 확인한다.
function hasParticipants() {
    const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM rps_participants
    `).get();

    return row.count > 0;
}

// 현재 가위바위보 참가자 목록만 비운다.
function resetGame() {
    db.prepare(`
        DELETE FROM rps_participants
    `).run();
}

//버튼 함수관련 --3개의 함수


// 게임 상태를 시작으로 바꾸고 채널에 시작 메시지를 보낸다.
function startGame(channel) {
    rpsGame.active = true;
    rpsGame.waitingForResetConfirm = false;
    rpsGame.resetRequesterId = null;

    channel.send('가위바위보 게임 시작! 참가하려면 `참여`를 입력하세요.');
}

// 유저를 공통 users 테이블과 가위바위보 참가자 테이블에 등록한다.
function addParticipant(user) {
    ensureUser(user);
    ensureRpsStats(user.id);

    db.prepare(`
        INSERT OR IGNORE INTO rps_participants (
            discord_user_id,
            username,
            is_alive,
            current_streak,
            best_streak
        )
        VALUES (?, ?, 1, 0, 0)
    `).run(user.id, user.username);

    db.prepare(`
        UPDATE rps_participants
        SET username = ?
        WHERE discord_user_id = ?
    `).run(user.username, user.id);
}

// 특정 유저가 현재 가위바위보 참가자인지 DB에서 가져온다.
function getParticipant(userId) {
    return db.prepare(`
        SELECT *
        FROM rps_participants
        WHERE discord_user_id = ?
    `).get(userId);
}

// 특정 유저의 가위바위보 전적 row가 없으면 새로 만든다.
function ensureRpsStats(userId) {
    db.prepare(`
        INSERT OR IGNORE INTO rps_stats (discord_user_id)
        VALUES (?)
    `).run(userId);
}

// 유저가 이겼을 때 연승, 최고 연승, 승리 수, 코인 보상을 처리한다.
function recordWin(userId) {
    db.prepare(`
        UPDATE rps_participants
        SET current_streak = current_streak + 1,
            best_streak = MAX(best_streak, current_streak + 1),
            is_alive = 1
        WHERE discord_user_id = ?
    `).run(userId);

    const participant = getParticipant(userId);

    db.prepare(`
        UPDATE rps_stats
        SET wins = wins + 1,
            best_streak = MAX(best_streak, ?)
        WHERE discord_user_id = ?
    `).run(participant.best_streak, userId);

    addCoins(userId, 10);
}

// 유저가 비겼을 때 무승부 횟수를 1 증가시킨다.
function recordDraw(userId) {
    ensureRpsStats(userId);

    db.prepare(`
        UPDATE rps_stats
        SET draws = draws + 1
        WHERE discord_user_id = ?
    `).run(userId);
}

// 유저가 졌을 때 탈락 처리하고 패배 수를 1 증가시킨다.
function eliminateUser(userId) {
    db.prepare(`
        UPDATE rps_participants
        SET is_alive = 0
        WHERE discord_user_id = ?
    `).run(userId);

    db.prepare(`
        UPDATE rps_stats
        SET losses = losses + 1
        WHERE discord_user_id = ?
    `).run(userId);
}

// 현재 탈락하지 않은 생존자 목록을 채팅에 출력하기 좋은 문자열로 만든다.
function getAliveListText() {
    const aliveUsers = db.prepare(`
        SELECT username, current_streak
        FROM rps_participants
        WHERE is_alive = 1
        ORDER BY current_streak DESC, username ASC
    `).all();

    if (aliveUsers.length === 0) {
        return '없음';
    }

    return aliveUsers
        .map(user => `${user.username} (${user.current_streak}연승)`)
        .join(', ');
}

// 이번 게임에서 최고 연승을 기록한 최종 승리자 목록을 가져온다.
function getFinalWinners() {
    return db.prepare(`
        SELECT discord_user_id, username, best_streak
        FROM rps_participants
        WHERE best_streak = (
            SELECT MAX(best_streak)
            FROM rps_participants
        )
        AND best_streak > 0
        ORDER BY username ASC
    `).all();
}

// 최종 승리자 목록을 채팅에 출력하기 좋은 문자열로 만든다.
function getFinalWinnerText() {
    const winners = getFinalWinners();

    if (winners.length === 0) {
        return '승리자가 없습니다.';
    }

    return winners
        .map(user => `${user.username} (${user.best_streak}연승)`)
        .join(', ');
}

// 최종 승리자들에게 우승 횟수와 우승 코인 보상을 지급한다.
function rewardFinalWinners() {
    const winners = getFinalWinners();

    for (const winner of winners) {
        ensureRpsStats(winner.discord_user_id);

        db.prepare(`
            UPDATE rps_stats
            SET champion_wins = champion_wins + 1
            WHERE discord_user_id = ?
        `).run(winner.discord_user_id);

        addCoins(winner.discord_user_id, 100);
    }

    return winners.length;
}

// index.js에서 전달받은 디스코드 메시지가 가위바위보 명령인지 처리한다.
function handleRpsMessage(message) {
    if (message.content === '가위바위보 시작') {
        if (hasParticipants()) {
            rpsGame.waitingForResetConfirm = true;
            rpsGame.resetRequesterId = message.author.id;

            message.channel.send('이전 참가자 기록이 있습니다. 초기화하고 새 게임을 시작할까요? `네` 또는 `아니오`로 답해주세요.');
            return true;
        }

        startGame(message.channel);
        return true;
    }

    if (rpsGame.waitingForResetConfirm) {
        if (message.author.id !== rpsGame.resetRequesterId) {
            message.reply('초기화를 요청한 사람만 답할 수 있습니다.');
            return true;
        }

        if (message.content === '네') {
            resetGame();
            startGame(message.channel);
            return true;
        }

        if (message.content === '아니오') {
            rpsGame.waitingForResetConfirm = false;
            rpsGame.resetRequesterId = null;

            message.channel.send('새 게임 시작을 취소했습니다.');
            return true;
        }

        message.reply('`네` 또는 `아니오`로 답해주세요.');
        return true;
    }

    if (message.content === '참여') {
        if (!rpsGame.active) {
            message.reply('아직 게임이 시작되지 않았습니다.');
            return true;
        }

        addParticipant(message.author);
        message.reply(`${message.author.username}님 참가 완료! 가위, 바위, 보 중 하나를 말해주세요.`);
        return true;
    }

    if (message.content === '가위바위보 종료') {
        if (!rpsGame.active) {
            message.reply('진행 중인 게임이 없습니다.');
            return true;
        }

        rpsGame.active = false;

        const finalWinners = getFinalWinnerText();
        const rewardCount = rewardFinalWinners();

        if (rewardCount > 0) {
            message.channel.send(`가위바위보 게임 종료! 최종 승리자: ${finalWinners}\n우승 보상으로 100코인을 지급했습니다.`);
        } else {
            message.channel.send(`가위바위보 게임 종료! ${finalWinners}`);
        }

        return true;
    }

    if (message.content === '가위바위보 전적') {
        ensureUser(message.author);
        ensureRpsStats(message.author.id);

        const stats = db.prepare(`
            SELECT wins, losses, draws, champion_wins, best_streak
            FROM rps_stats
            WHERE discord_user_id = ?
        `).get(message.author.id);

        message.reply(
            `전적: ${stats.wins}승 ${stats.losses}패 ${stats.draws}무 / 우승 ${stats.champion_wins}회 / 최고 ${stats.best_streak}연승`
        );
        return true;
    }

    if (!rpsGame.active) return false;
    if (!choices.includes(message.content)) return false;

    const participant = getParticipant(message.author.id);

    if (!participant) {
        message.reply('먼저 `참여`를 입력해야 합니다.');
        return true;
    }

    if (participant.is_alive === 0) {
        message.reply('이미 탈락했습니다. 다음 게임을 기다려주세요.');
        return true;
    }

    const userChoice = message.content;
    const botChoice = getBotChoice();
    const result = getResult(userChoice, botChoice);

    if (result === 'win') {
        recordWin(message.author.id);

        const aliveList = getAliveListText();

        message.reply(`나는 ${botChoice}! ${message.author.username}님 승리! 10코인을 얻었습니다.`);
        message.channel.send(`현재 생존자: ${aliveList}`);
        return true;
    }

    if (result === 'lose') {
        eliminateUser(message.author.id);

        const aliveList = getAliveListText();

        message.reply(`나는 ${botChoice}! ${message.author.username}님 탈락!`);
        message.channel.send(`현재 생존자: ${aliveList}`);
        return true;
    }

    recordDraw(message.author.id);
    message.reply(`나는 ${botChoice}! 비겼습니다. 연승은 오르지 않습니다.`);
    return true;
}
//핵심은 handleRpsMessage()야.
//index.js가 메시지를 받으면 이 함수에 넘기고, 이 함수가 처리했으면 true, 가위바위보와 관계없으면 false를 돌려줘.
module.exports = {
    handleRpsMessage
};