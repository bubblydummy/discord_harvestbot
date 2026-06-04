
//라이브러리 불러오기
const { Client, Events, GatewayIntentBits } = require('discord.js');
const Database = require('better-sqlite3');
const { token } = require('./config.json');
//db 연결
const db = new Database('rps.db');
//db 구조 갈아엎을 필요 없음
let needsDbReset = false;

//participants 테이블안에 특정 컬럼이 있는지 확인한다. ..있으면 true 없으면 false
function tableHasColumn(columnName) {
    const columns = db.prepare(`
        PRAGMA table_info(participants)
    `).all();

    return columns.some(column => column.name === columnName);
}

//테이블이 없으면 만들지만, 있으면 아무것도 안한다. but 예전테이블이 있을 수 도 있음=> 구조검사
function createParticipantsTable() {
    db.prepare(`
        CREATE TABLE IF NOT EXISTS participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            discord_user_id TEXT NOT NULL UNIQUE,
            username TEXT NOT NULL,
            is_alive INTEGER NOT NULL DEFAULT 1,
            current_streak INTEGER NOT NULL DEFAULT 0,
            best_streak INTEGER NOT NULL DEFAULT 0,
            joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `).run();
}

//테이블 구조 검사
if (hasParticipantsTable()) {
   

    const hasCurrentStreak = tableHasColumn('current_streak');
    const hasBestStreak = tableHasColumn('best_streak');

   

    if (!hasCurrentStreak || !hasBestStreak) {
        needsDbReset = true;
        console.log('DB 구조가 낡았습니다. needsDbReset = true');
    } else {
        console.log('DB 구조가 정상입니다. needsDbReset = false');
    }
} else {
    console.log('participants 테이블 없음. 새로 생성합니다.');
    createParticipantsTable();
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

const choices = ['가위','바위', '보'];
//게임 상태 저장용 객체
let rpsGame = {
    active: false,//게임 안함 상태
    waitingForResetConfirm: false,// 봇이 "초기화할까요 /네 /아니오를 기다리는상태"
    resetRequesterId: null/// 누가 초기화를 요청했는가
};


//가위 바위 보중 하나를 랜덤으로 고름
function getBotChoice() {
    return choices[Math.floor(Math.random() * choices.length)];
}

//유저와 봇을 선택해서 win or lose , draw 반환
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

//db는 유지하고 참가자 목록만 비운다.
function resetGame() {
    db.prepare('DELETE FROM participants').run();
}

//테이블이 있는지를 확인하는 함수
function hasParticipantsTable() {
    const table = db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
        AND name = 'participants'
    `).get();

    return table !== undefined;
}

//게임 상태를 시작으로 바꾸고, 채널에 게임 시작 메시지를 보낸다.
function startGame(channel) {
    rpsGame.active = true;
    rpsGame.waitingForResetConfirm = false;
    rpsGame.resetRequesterId = null;

    channel.send('가위바위보 게임 시작! 참가하려면 `참여`를 입력하세요.');
}

//유저를 참가자 db에 추가한다. 이미 있으면 중복 추가하지 않는다. 이름은 최신이름으로 업데이트한다.
function addParticipant(user) {
    db.prepare(`
        INSERT OR IGNORE INTO participants (
            discord_user_id,
            username,
            is_alive,
            current_streak,
            best_streak
        )
        VALUES (?, ?, 1, 0, 0)
    `).run(user.id, user.username);

    db.prepare(`
        UPDATE participants
        SET username = ?
        WHERE discord_user_id = ?
    `).run(user.username, user.id);
}

//이 유저가 테이블에 있는지 가져온다.
function getParticipant(userId) {
    return db.prepare(`
        SELECT *
        FROM participants
        WHERE discord_user_id = ?
    `).get(userId);
}

//연승 기록 업데이트~
function recordWin(userId) {
    db.prepare(`
        UPDATE participants
        SET current_streak = current_streak + 1,
            best_streak = MAX(best_streak, current_streak + 1),
            is_alive = 1
        WHERE discord_user_id = ?
    `).run(userId);
}

//진 유저는 탈락
function eliminateUser(userId) {
    db.prepare(`
        UPDATE participants
        SET is_alive = 0
        WHERE discord_user_id = ?
    `).run(userId);
}

//살았는 사람 목록을 문자열로 만들기
function getAliveListText() {
    const aliveUsers = db.prepare(`
        SELECT username, current_streak, best_streak
        FROM participants
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

//게임 전체에서 최고 연승을 기록한 사람을 찾는다.
function getFinalWinnerText() {
    const winners = db.prepare(`
        SELECT username, best_streak
        FROM participants
        WHERE best_streak = (
            SELECT MAX(best_streak)
            FROM participants
        )
        AND best_streak > 0
        ORDER BY username ASC
    `).all();

    if (winners.length === 0) {
        return '승리자가 없습니다.';
    }

    return winners
        .map(user => `${user.username} (${user.best_streak}연승)`)
        .join(', ');
}

//이전 참가자가 있는지 살핌
function hasParticipants() {
    const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM participants
    `).get();

    return row.count > 0;
}

client.once(Events.ClientReady, readyClient => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
});

//누군가 디스코드 채팅을 칠때마다 실행되는 부분
client.on('messageCreate', (message) => {
    if (message.author.bot) return;

    if (message.content === 'ping') {
        message.reply('pong');
        return;
    }

    if (message.content === '가위바위보 시작') {
        if (hasParticipants()) {
            rpsGame.waitingForResetConfirm = true;
            rpsGame.resetRequesterId = message.author.id;

            message.channel.send('이전 참가자 기록이 있습니다. 초기화하고 새 게임을 시작할까요? `네` 또는 `아니오`로 답해주세요.');
            return;
        }

        startGame(message.channel);
        return;
    }

    //봇이 네/아니오를 처리
    if (rpsGame.waitingForResetConfirm) {
        if (message.author.id !== rpsGame.resetRequesterId) {
            message.reply('초기화를 요청한 사람만 답할 수 있습니다.');
            return;
        }

        if (message.content === '네') {
            resetGame();
            startGame(message.channel);
            return;
        }// db를 초기화함(사람들을 초기화)

        if (message.content === '아니오') {
            rpsGame.waitingForResetConfirm = false;
            rpsGame.resetRequesterId = null;

            message.channel.send('새 게임 시작을 취소했습니다.');
            return;
        }// 게임 시작 취소

        message.reply('`네` 또는 `아니오`로 답해주세요.');
        return;
    }


    //게임 중이 아니면 막고, 게임중이면 참가자로 등록한다.
    if (message.content === '참여') {
        if (!rpsGame.active) {
            message.reply('아직 게임이 시작되지 않았습니다.');
            return;
        }

        addParticipant(message.author);
        message.reply(`${message.author.username}님 참가 완료! 가위, 바위, 보 중 하나를 말해주세요.`);
        return;
    }


    //게임을 종료하고 최고 연승자를 발표한다.
    if (message.content === '가위바위보 종료') {
        if (!rpsGame.active) {
            message.reply('진행중인 게임이 없습니다.');
            return;
        }

        rpsGame.active = false;

        const finalWinners = getFinalWinnerText();
        message.channel.send(`가위바위보 게임 종료! 최종 승리자: ${finalWinners}`);
        return;
    }
    //게임이 시작되지 않았으면 가위 바위 보를 쳐도 무시한다.(??)
    if (!rpsGame.active) return;

    //메시지가 가위, 바위, 보 중 하나가 아니라도 무시한다.
    if (!choices.includes(message.content)) return;


    //참가 안한 사람을 막는다.
    const participant = getParticipant(message.author.id);

    if (!participant) {
        message.reply('먼저 `참여`를 입력해야 합니다.');
        return;
    }
    //탈락자도 막는다.
    if (participant.is_alive === 0) {
        message.reply('이미 탈락했습니다. 다음 게임을 기다려주세요.');
        return;
    }

    // ------------<실제 가위바위 보 처리,  유저선택저장, 봇 선택 랜덤 생성, 승패계산
    const userChoice = message.content;
    const botChoice = getBotChoice();
    const result = getResult(userChoice, botChoice);

    if (result === 'win') {
        recordWin(message.author.id);

        const aliveList = getAliveListText();

        message.reply(`나는 ${botChoice}! ${message.author.username}님 승리!`);
        message.channel.send(`현재 생존자: ${aliveList}`);
        return;
    }

    if (result === 'lose') {
        eliminateUser(message.author.id);

        const aliveList = getAliveListText();

        message.reply(`나는 ${botChoice}! ${message.author.username}님 탈락!`);
        message.channel.send(`현재 생존자: ${aliveList}`);
        return;
    }

    message.reply(`나는 ${botChoice}! 비겼습니다. 연승은 오르지 않습니다.`);
});

client.login(token);