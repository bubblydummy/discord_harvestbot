const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');

const { db, ensureUser, addCoins } = require('./db');

const choices = ['가위', '바위', '보'];

let rpsGame = {
    active: false,// 가위바위보 게임이 현재 진행 중인지 저장한다.
    waitingForResetConfirm: false, // 이전 참가자 기록을 초기화할지 확인 답변을 기다리는 중인지 저장한다.
    resetRequesterId: null,   // 초기화를 요청한 사람의 디스코드 유저 ID를 저장한다.
    panelMessage: null //패널 메시지를 기억하는 자리
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

function getBotChoice() {
    return choices[Math.floor(Math.random() * choices.length)];
}

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

function hasParticipants() {
    const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM rps_participants
    `).get();

    return row.count > 0;
}

function resetGame() {
    db.prepare(`
        DELETE FROM rps_participants
    `).run();
}

function createRpsControlRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('rps_start')
            .setLabel('시작')
            .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
            .setCustomId('rps_join')
            .setLabel('참여')
            .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
            .setCustomId('rps_stats')
            .setLabel('전적')
            .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId('rps_end')
            .setLabel('종료')
            .setStyle(ButtonStyle.Danger)
    );
}

function createRpsChoiceRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('rps_choice_가위')
            .setLabel('가위')
            .setEmoji('✂️')
            .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
            .setCustomId('rps_choice_바위')
            .setLabel('바위')
            .setEmoji('🪨')
            .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId('rps_choice_보')
            .setLabel('보')
            .setEmoji('📄')
            .setStyle(ButtonStyle.Primary)
    );
}
//기존 패널을 지우고 새 패널을 보냄
async function sendRpsPanel(channel) {
    if (rpsGame.panelMessage) {
        try {
            await rpsGame.panelMessage.delete();
        } catch (error) {
        }
    }

    rpsGame.panelMessage = await channel.send({
        content: '가위바위보 패널',
        components: [createRpsControlRow(), createRpsChoiceRow()]
    });
}

function startGame(channel) {
    rpsGame.active = true;
    rpsGame.waitingForResetConfirm = false;
    rpsGame.resetRequesterId = null;

    channel.send('가위바위보 게임이 시작되었습니다. `참여` 버튼을 누른 뒤 가위/바위/보를 선택하세요.');
}

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

function getParticipant(userId) {
    return db.prepare(`
        SELECT *
        FROM rps_participants
        WHERE discord_user_id = ?
    `).get(userId);
}

function ensureRpsStats(userId) {
    db.prepare(`
        INSERT OR IGNORE INTO rps_stats (discord_user_id)
        VALUES (?)
    `).run(userId);
}

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

function recordDraw(userId) {
    ensureRpsStats(userId);

    db.prepare(`
        UPDATE rps_stats
        SET draws = draws + 1
        WHERE discord_user_id = ?
    `).run(userId);
}

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

function getFinalWinnerText() {
    const winners = getFinalWinners();

    if (winners.length === 0) {
        return '승리자가 없습니다.';
    }

    return winners
        .map(user => `${user.username} (${user.best_streak}연승)`)
        .join(', ');
}

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

async function handleRpsMessage(message) {
    if (message.content === '가위바위보') {
        await sendRpsPanel(message.channel);
        return true;
    }

    return false;
}

async function handleRpsInteraction(interaction) {
    if (!interaction.isButton()) return false;

    if (interaction.customId === 'rps_start') {
        if (hasParticipants()) {
            rpsGame.waitingForResetConfirm = true;
            rpsGame.resetRequesterId = interaction.user.id;

            await interaction.reply({
                content: '이전 참가자 기록이 있습니다. 초기화하고 새 게임을 시작할까요? 아래 버튼을 선택하세요.',
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('rps_confirm_yes')
                            .setLabel('네')
                            .setStyle(ButtonStyle.Danger),

                        new ButtonBuilder()
                            .setCustomId('rps_confirm_no')
                            .setLabel('아니오')
                            .setStyle(ButtonStyle.Secondary)
                    )
                ]
            });
            return true;
        }

        await interaction.reply({
            content: '게임을 시작했습니다.'
        });

        startGame(interaction.channel);
        await sendRpsPanel(interaction.channel);
        return true;
    }

    if (interaction.customId === 'rps_confirm_yes') {
        if (interaction.user.id !== rpsGame.resetRequesterId) {
            await interaction.reply({
                content: '초기화를 요청한 사람만 답할 수 있습니다.'
            });
            return true;
        }

        resetGame();

        await interaction.update({
            content: '이전 참가자 기록을 초기화하고 새 게임을 시작했습니다.',
            components: []
        });

        startGame(interaction.channel);
        await sendRpsPanel(interaction.channel);
        return true;
    }

    if (interaction.customId === 'rps_confirm_no') {
        if (interaction.user.id !== rpsGame.resetRequesterId) {
            await interaction.reply({
                content: '초기화를 요청한 사람만 답할 수 있습니다.'
            });
            return true;
        }

        rpsGame.waitingForResetConfirm = false;
        rpsGame.resetRequesterId = null;

        await interaction.update({
            content: '새 게임 시작을 취소했습니다.',
            components: []
        });

        await sendRpsPanel(interaction.channel);
        return true;
    }

    if (interaction.customId === 'rps_join') {
        if (!rpsGame.active) {
            await interaction.reply({
                content: '아직 게임이 시작되지 않았습니다.'
            });

            await sendRpsPanel(interaction.channel);
            return true;
        }

        addParticipant(interaction.user);

        await interaction.reply({
            content: `${interaction.user.username}님 참가 완료! 이제 가위, 바위, 보 버튼을 선택하세요.`
        });

        await sendRpsPanel(interaction.channel);
        return true;
    }

    if (interaction.customId === 'rps_stats') {
        ensureUser(interaction.user);
        ensureRpsStats(interaction.user.id);

        const stats = db.prepare(`
            SELECT wins, losses, draws, champion_wins, best_streak
            FROM rps_stats
            WHERE discord_user_id = ?
        `).get(interaction.user.id);

        await interaction.reply({
            content: `전적: ${stats.wins}승 ${stats.losses}패 ${stats.draws}무 / 우승 ${stats.champion_wins}회 / 최고 ${stats.best_streak}연승`
        });

        await sendRpsPanel(interaction.channel);
        return true;
    }

    if (interaction.customId === 'rps_end') {
        if (!rpsGame.active) {
            await interaction.reply({
                content: '진행 중인 게임이 없습니다.'
            });

            await sendRpsPanel(interaction.channel);
            return true;
        }

        rpsGame.active = false;

        const finalWinners = getFinalWinnerText();
        const rewardCount = rewardFinalWinners();

        if (rewardCount > 0) {
            await interaction.reply(`가위바위보 게임 종료! 최종 승리자: ${finalWinners}\n우승 보상으로 100코인을 지급했습니다.`);
        } else {
            await interaction.reply(`가위바위보 게임 종료! ${finalWinners}`);
        }

        await deleteRpsPanel();
        return true;
    }

    if (interaction.customId.startsWith('rps_choice_')) {
        if (!rpsGame.active) {
            await interaction.reply({
                content: '아직 게임이 시작되지 않았습니다.'
            });

            await sendRpsPanel(interaction.channel);
            return true;
        }

        const userChoice = interaction.customId.replace('rps_choice_', '');
        const participant = getParticipant(interaction.user.id);

        if (!participant) {
            await interaction.reply({
                content: '먼저 `참여` 버튼을 눌러야 합니다.'
            });

            await sendRpsPanel(interaction.channel);
            return true;
        }

        if (participant.is_alive === 0) {
            await interaction.reply({
                content: '이미 탈락했습니다. 다음 게임을 기다려주세요.'
            });

            await sendRpsPanel(interaction.channel);
            return true;
        }

        const botChoice = getBotChoice();
        const result = getResult(userChoice, botChoice);

        if (result === 'win') {
            recordWin(interaction.user.id);

            const aliveList = getAliveListText();

            await interaction.reply(`나는 ${botChoice}! ${interaction.user.username}님 승리! 10코인을 얻었습니다.\n현재 생존자: ${aliveList}`);
            await sendRpsPanel(interaction.channel);
            return true;
        }

        if (result === 'lose') {
            eliminateUser(interaction.user.id);

            const aliveList = getAliveListText();

            await interaction.reply(`나는 ${botChoice}! ${interaction.user.username}님 탈락!\n현재 생존자: ${aliveList}`);
            await sendRpsPanel(interaction.channel);
            return true;
        }

        recordDraw(interaction.user.id);

        await interaction.reply(`나는 ${botChoice}! 비겼습니다. 연승은 오르지 않습니다.`);
        await sendRpsPanel(interaction.channel);
        return true;
    }

    return false;
}

module.exports = {
    handleRpsMessage,
    handleRpsInteraction
};