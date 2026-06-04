const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const { db, ensureUser, getUser } = require('./db');

const GAME_MINUTES_PER_REAL_SECOND = 10;
const MINUTES_PER_DAY = 24 * 60;
const DAYS_PER_SEASON = 28;

const seasons = ['봄', '여름', '가을', '겨울'];
// 작물 관련 공통 데이터
const cropItems = {
    wheat: {
        name: '밀',
        emoji: '🌾',
        seedPrice: 10
    },
    potato: {
        name: '감자',
        emoji: '🥔',
        seedPrice: 20
    },
    carrot: {
        name: '당근',
        emoji: '🥕',
        seedPrice: 25
    },
    strawberry: {
        name: '딸기',
        emoji: '🍓',
        seedPrice: 40
    }
};

const shopItems = Object.fromEntries(
    Object.entries(cropItems).map(([cropId, crop]) => [
        `${cropId}_seed`,
        {
            name: `${crop.name} 씨앗`,
            emoji: crop.emoji,
            price: crop.seedPrice
        }
    ])
);

let farmUi = {
    farmPanelMessage: null,

    // 현재 농장 패널을 보고 있는 유저를 기억한다.
    farmPanelUser: null,

    // 1초마다 농장 패널을 갱신하는 타이머를 기억한다.
    farmRealtimeTimer: null,


    inventoryPanelMessage: null,
    shopPanelMessage: null,
    purchasePanelMessage: null,
    purchaseDrafts: new Map(),

    // 판매 패널 메시지를 기억한다.
    sellPanelMessage: null,

    // 유저별 판매 임시 정보를 저장한다.
    // 예: 어떤 아이템을 몇 개 판매하려는지
    sellDrafts: new Map(),

    // 인벤토리를 닫았을 때 돌아갈 화면을 저장한다.
    inventoryReturnTo: 'farm',

    // 인벤토리를 어떤 목적으로 열었는지 저장한다.
    // normal = 일반 아이템 선택, sell = 판매할 아이템 선택
    inventoryMode: 'normal'
};

//농장 패널 관련 db
db.prepare(`
    CREATE TABLE IF NOT EXISTS farms (
        discord_user_id TEXT PRIMARY KEY,
        year INTEGER NOT NULL DEFAULT 1,
        season TEXT NOT NULL DEFAULT '봄',
        day INTEGER NOT NULL DEFAULT 1,
        time_minutes INTEGER NOT NULL DEFAULT 360,
        weather TEXT NOT NULL DEFAULT '맑음',
        inventory_open INTEGER NOT NULL DEFAULT 0,
        plots TEXT NOT NULL DEFAULT 'empty,empty,empty,empty,empty,empty,empty,empty,empty'
    )
`).run();

//인벤토리관련 db
db.prepare(`
    CREATE TABLE IF NOT EXISTS farm_inventory (
        discord_user_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (discord_user_id, item_id)
    )
`).run();


// farms 테이블에 특정 컬럼이 있는지 확인한다.
// 예: farmHasColumn('plot_planted_at')이라고 부르면
// farms 테이블 안에 plot_planted_at 컬럼이 있는지 검사한다.
function farmHasColumn(columnName) {
    const columns = db.prepare(`
        PRAGMA table_info(farms)
    `).all();

    return columns.some(column => column.name === columnName);
}

// farms 테이블에 필요한 컬럼들이 있는지 확인하고,
// 없으면 새 컬럼을 추가한다.
function ensureFarmColumns() {
    if (!farmHasColumn('year')) {
        db.prepare(`
            ALTER TABLE farms
            ADD COLUMN year INTEGER NOT NULL DEFAULT 1
        `).run();
    }

    if (!farmHasColumn('plot_planted_at')) {
        db.prepare(`
            ALTER TABLE farms
            ADD COLUMN plot_planted_at TEXT NOT NULL DEFAULT '-1,-1,-1,-1,-1,-1,-1,-1,-1'
        `).run();
    }

    // 현재 농장 조작 모드를 저장한다.
    // normal = 기본, plant = 심기, harvest = 수확
    if (!farmHasColumn('mode')) {
        db.prepare(`
            ALTER TABLE farms
            ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal'
        `).run();
    }
}

// 봇이 실행될 때 farms 테이블 구조를 확인한다.
// plot_planted_at 컬럼이 없으면 자동으로 추가된다.
ensureFarmColumns();



// 상점 진열대 만들기
function createShopRows() {
    const seedButtons = Object.entries(shopItems).map(([itemId, item]) =>
        new ButtonBuilder()
            .setCustomId(`farm_shop_item_${itemId}`)
            .setLabel(item.name)
            .setEmoji(item.emoji)
            .setStyle(ButtonStyle.Success)
    );

    return [
        new ActionRowBuilder().addComponents(seedButtons),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('farm_shop_sell')
                .setLabel('판매')
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId('farm_shop_close')
                .setLabel('X 닫기')
                .setStyle(ButtonStyle.Danger)
        )
    ];
}

// 상점 패널 보내기
async function sendShopPanel(channel, user) {
    if (farmUi.shopPanelMessage) {
        try {
            await farmUi.shopPanelMessage.delete();
        } catch (error) {
        }
    }

    farmUi.shopPanelMessage = await channel.send({
        content: `${user.username}님의 씨앗 상점\n점원이 씨앗을 진열해두었습니다.`,
        components: createShopRows()
    });
}



// 구매 패널에 들어갈 버튼 줄을 만든다.
// 수량 감소, 수량 증가, 구매 확정, 취소 버튼을 한 줄로 구성한다.
function createPurchaseRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('farm_purchase_decrease')
                .setLabel('<')
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId('farm_purchase_increase')
                .setLabel('>')
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId('farm_purchase_confirm')
                .setLabel('구매')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId('farm_purchase_cancel')
                .setLabel('취소')
                .setStyle(ButtonStyle.Danger)
        )
    ];
}

// 특정 유저가 현재 구매하려고 선택해둔 임시 구매 정보를 가져온다.
// 예: 어떤 씨앗을 몇 개 구매하려는지
function getPurchaseDraft(userId) {
    return farmUi.purchaseDrafts.get(userId);
}

// 특정 유저의 임시 구매 정보를 저장한다.
// 예: userId가 potato_seed를 3개 구매하려는 상태
function setPurchaseDraft(userId, itemId, quantity) {
    farmUi.purchaseDrafts.set(userId, {
        itemId,
        quantity
    });
}



// 현재 임시 구매 정보를 바탕으로 구매 패널에 보여줄 문구를 만든다.
// 선택한 씨앗 이름, 수량, 총 가격을 표시한다.
function createPurchaseContent(userId) {
    const draft = getPurchaseDraft(userId);
    const item = shopItems[draft.itemId];
    const totalPrice = item.price * draft.quantity;

    return `${item.emoji} ${item.name}\n\n<  ${draft.quantity}개  >\n\n${item.name}을 ${draft.quantity}개 구매하겠습니까?\n가격: ${totalPrice}G`;
}


// 구매 패널 메시지를 디스코드 채널에 보낸다.
// 기존 구매 패널이 있으면 먼저 삭제하고, 새 구매 패널을 띄운다.
async function sendPurchasePanel(channel, user, itemId) {
    if (farmUi.purchasePanelMessage) {
        try {
            await farmUi.purchasePanelMessage.delete();
        } catch (error) {
        }
    }

    setPurchaseDraft(user.id, itemId, 1);

    farmUi.purchasePanelMessage = await channel.send({
        content: createPurchaseContent(user.id),
        components: createPurchaseRows()
    });
}

// 판매 임시 정보를 가져온다.
function getSellDraft(userId) {
    return farmUi.sellDrafts.get(userId);
}

// 판매 임시 정보를 저장한다.
function setSellDraft(userId, itemId, quantity) {
    farmUi.sellDrafts.set(userId, {
        itemId,
        quantity
    });
}

// 아이템 판매 정보를 가져온다.
// 현재는 상점 구매 가격과 같은 가격+ 수확물은 씨앗의 2배가격
function getItemSellInfo(itemId) {
    if (itemId.endsWith('_seed')) {
        const cropId = itemId.replace('_seed', '');
        const crop = cropItems[cropId];

        if (!crop) return null;

        return {
            name: `${crop.name} 씨앗`,
            emoji: crop.emoji,
            price: crop.seedPrice
        };
    }

    const crop = cropItems[itemId];

    if (!crop) return null;

    return {
        name: crop.name,
        emoji: crop.emoji,
        price: crop.seedPrice * 2
    };
}

// 판매 패널 버튼 줄을 만든다.
function createSellRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('farm_sell_decrease')
                .setLabel('<')
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId('farm_sell_increase')
                .setLabel('>')
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId('farm_sell_quantity_open')
                .setLabel('수량입력')
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId('farm_sell_confirm')
                .setLabel('판매')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId('farm_sell_cancel')
                .setLabel('취소')
                .setStyle(ButtonStyle.Danger)
        )
    ];
}

function createSellQuantityModal(quantity) {
    const modal = new ModalBuilder()
        .setCustomId('farm_sell_quantity_modal')
        .setTitle('판매 수량 입력');

    const quantityInput = new TextInputBuilder()
        .setCustomId('sell_quantity')
        .setLabel('판매할 수량')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(quantity))
        .setPlaceholder('예: 3');

    modal.addComponents(
        new ActionRowBuilder().addComponents(quantityInput)
    );

    return modal;
}


// 판매 패널에 표시할 문구를 만든다.
function createSellContent(userId) {
    const draft = getSellDraft(userId);
    const item = getItemSellInfo(draft.itemId);
    const totalPrice = item.price * draft.quantity;

    return `${item.emoji} ${item.name}\n\n<  ${draft.quantity}개  >\n\n${item.name}을 ${draft.quantity}개 판매하겠습니까?\n판매가: ${totalPrice}G`;
}

// 판매 패널을 보낸다.
// 기존 판매 패널이 있으면 삭제하고 새로 보낸다.
async function sendSellPanel(channel, user, itemId) {
    if (farmUi.sellPanelMessage) {
        try {
            await farmUi.sellPanelMessage.delete();
        } catch (error) {
        }
    }

    setSellDraft(user.id, itemId, 1);

    farmUi.sellPanelMessage = await channel.send({
        content: createSellContent(user.id),
        components: createSellRows()
    });
}

// 인벤토리에서 아이템 수량을 차감한다.
// 수량이 0 이하가 되면 해당 아이템을 DB에서 삭제한다.
function removeInventoryItem(userId, itemId, quantity) {
    db.prepare(`
        UPDATE farm_inventory
        SET quantity = quantity - ?
        WHERE discord_user_id = ?
        AND item_id = ?
    `).run(quantity, userId, itemId);

    db.prepare(`
        DELETE FROM farm_inventory
        WHERE discord_user_id = ?
        AND item_id = ?
        AND quantity <= 0
    `).run(userId, itemId);
}






function addInventoryItem(userId, itemId, quantity) {
    db.prepare(`
        INSERT INTO farm_inventory (discord_user_id, item_id, quantity)
        VALUES (?, ?, ?)
        ON CONFLICT(discord_user_id, item_id)
        DO UPDATE SET quantity = quantity + excluded.quantity
    `).run(userId, itemId, quantity);
}





function getCurrentTimestamp() {
    return Date.now();
}

function addMissingFarmColumns() {
    const columns = db.prepare(`
        PRAGMA table_info(farms)
    `).all();

    const columnNames = columns.map(column => column.name);

    if (!columnNames.includes('last_updated_at')) {
        db.prepare(`
            ALTER TABLE farms ADD COLUMN last_updated_at INTEGER NOT NULL DEFAULT 0
        `).run();

        db.prepare(`
            UPDATE farms
            SET last_updated_at = ?
            WHERE last_updated_at = 0
        `).run(getCurrentTimestamp());
    }


    if (!columnNames.includes('selected_item')) {
        db.prepare(`
            ALTER TABLE farms ADD COLUMN selected_item TEXT
        `).run();
    }

}

addMissingFarmColumns();

function ensureFarm(userId) {
    db.prepare(`
        INSERT OR IGNORE INTO farms (
            discord_user_id,
            season,
            day,
            time_minutes,
            weather,
            inventory_open,
            plots,
            last_updated_at
        )
        VALUES (?, '봄', 1, 360, '맑음', 0, 'empty,empty,empty,empty,empty,empty,empty,empty,empty', ?)
    `).run(userId, getCurrentTimestamp());
}

function getFarm(userId) {
    return db.prepare(`
        SELECT *
        FROM farms
        WHERE discord_user_id = ?
    `).get(userId);
}

function saveFarmTime(userId, year, season, day, timeMinutes) {
    db.prepare(`
        UPDATE farms
        SET year = ?,
            season = ?,
            day = ?,
            time_minutes = ?,
            last_updated_at = ?
        WHERE discord_user_id = ?
    `).run(year, season, day, timeMinutes, getCurrentTimestamp(), userId);
}

function getSeasonIndex(season) {
    const index = seasons.indexOf(season);
    return index === -1 ? 0 : index;
}

function advanceDate(year,season, day, extraDays) {
    let newYear = year;
    let seasonIndex = getSeasonIndex(season);
    let newDay = day + extraDays;

    while (newDay > DAYS_PER_SEASON) {
        newDay -= DAYS_PER_SEASON;
        seasonIndex = (seasonIndex + 1) % seasons.length;

        if (seasonIndex === 0) {
            newYear += 1;
        }
    }

    return {
        year: newYear,
        season: seasons[seasonIndex],
        day: newDay
    };
}

function updateFarmTime(userId) {
    const farm = getFarm(userId);

    const elapsedSeconds = Math.floor((getCurrentTimestamp() - farm.last_updated_at) / 1000);

    if (elapsedSeconds <= 0) {
        return farm;
    }

    const elapsedGameMinutes = elapsedSeconds * GAME_MINUTES_PER_REAL_SECOND;
    const totalMinutes = farm.time_minutes + elapsedGameMinutes;

    const extraDays = Math.floor(totalMinutes / MINUTES_PER_DAY);
    const newTimeMinutes = totalMinutes % MINUTES_PER_DAY;
    const newDate = advanceDate(farm.year, farm.season, farm.day, extraDays);

    saveFarmTime(userId, newDate.year, newDate.season, newDate.day, newTimeMinutes);

    return getFarm(userId);
}

function formatTime(timeMinutes) {
    const hour = Math.floor(timeMinutes / 60);
    const minute = timeMinutes % 60;

    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function getTimeLabel(timeMinutes) {
    if (timeMinutes >= 360 && timeMinutes < 720) return '아침';
    if (timeMinutes >= 720 && timeMinutes < 1080) return '낮';
    if (timeMinutes >= 1080 && timeMinutes < 1320) return '저녁';
    return '밤';
}

//밭을 이미지화함
function renderPlots(plotsText) {
    const plots = plotsText.split(',');

    const icons = {
        empty: '🟫',
        seed: '🌱',
        growing: '🌿',
        ready: '🌾'
    };

    return [
        plots.slice(0, 3).map(plot => icons[plot] || '❓').join(' '),
        plots.slice(3, 6).map(plot => icons[plot] || '❓').join(' '),
        plots.slice(6, 9).map(plot => icons[plot] || '❓').join(' ')
    ].join('\n');
}

// 밭을 버튼화함
function getPlotButtonInfo(plot) {
    if (plot === 'empty') {
        return {
            emoji: '🟫',
            disabled: false,
            style: ButtonStyle.Secondary
        };
    }

    if (plot.endsWith('_seed')) {
        return {
            emoji: '🌱',
            disabled: true,
            style: ButtonStyle.Success
        };
    }

    if (plot.endsWith('_growing')) {
        return {
            emoji: '🌿',
            disabled: true,
            style: ButtonStyle.Success
        };
    }

    if (plot.endsWith('_ready')) {
        const cropEmoji = {
            wheat_ready: '🌾',
            potato_ready: '🥔',
            carrot_ready: '🥕',
            strawberry_ready: '🍓'
        };

        return {
            emoji: cropEmoji[plot] || '🌾',
            disabled: false,
            style: ButtonStyle.Primary
        };
    }

    return {
        emoji: '❓',
        disabled: true,
        style: ButtonStyle.Secondary
    };
}

function createPlotRows(farm) {
    const plots = farm.plots.split(',');
    const rows = [];

    for (let row = 0; row < 3; row++) {
        const actionRow = new ActionRowBuilder();

        for (let col = 0; col < 3; col++) {
            const index = row * 3 + col;
            const plot = plots[index];
            const info = getPlotButtonInfo(plot);

            actionRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`farm_plot_${index}`)
                    .setEmoji(info.emoji)
                    .setStyle(info.style)
                    .setDisabled(info.disabled)
            );
        }

        rows.push(actionRow);
    }

    return rows;
}

function getInventory(userId) {
    return db.prepare(`
        SELECT item_id, quantity
        FROM farm_inventory
        WHERE discord_user_id = ?
        AND quantity > 0
        ORDER BY item_id ASC
    `).all(userId);
}
//인벤토리를 글자로 보여주는 함수(시각화할 예정이라 중요도는 낮음)
function renderInventory(inventory) {
    if (inventory.length === 0) {
        return '비어 있음';
    }


    const itemNames = {
        wheat_seed: '밀 씨앗',
        wheat: '밀',
        potato_seed: '감자 씨앗',
        potato: '감자'
    };

    return inventory
        .map(item => `${itemNames[item.item_id] || item.item_id} x${item.quantity}`)
        .join('\n');
}


//인벤토리 18칸으로 만듬
function buildInventorySlots(inventory) {
    const itemInfo = {
        wheat_seed: { label: '밀씨앗', emoji: '🌱' },
        wheat: { label: '밀', emoji: '🌾' },
        potato_seed: { label: '감자씨앗', emoji: '🥔' },
        potato: { label: '감자', emoji: '🥔' }
    };

    const slots = Array(18).fill(null);

    inventory.slice(0, 18).forEach((item, index) => {
        const info = itemInfo[item.item_id] || {
            label: item.item_id,
            emoji: '🎒'
        };

        slots[index] = {
            label: `${info.label}x${item.quantity}`,
            emoji: info.emoji,
            itemId: item.item_id
        };
    });

    return slots;
}
//버튼화함
function createInventoryRows(inventorySlots) {
    const rows = [];

    for (let row = 0; row < 4; row++) {
        const actionRow = new ActionRowBuilder();

        const start = row * 5;
        const end = Math.min(start + 5, 18);

        for (let i = start; i < end; i++) {
            const item = inventorySlots[i];

            actionRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`farm_inventory_slot_${i}`)
                    .setLabel(item ? item.label : `${i + 1}`)
                    .setEmoji(item ? item.emoji : '⬛')
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        rows.push(actionRow);
    }

    rows.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('farm_inventory_close')
                .setLabel('X 닫기')
                .setStyle(ButtonStyle.Danger)
        )
    );




    return rows;
}

// 인벤토리 패널을 보낸다.
// returnTo는 인벤토리를 닫았을 때 돌아갈 화면을 의미한다.
// mode는 인벤토리를 일반 선택용으로 열지, 판매용으로 열지 구분한다.
async function sendInventoryPanel(channel, user, returnTo = 'farm', mode = 'normal') {
    farmUi.inventoryReturnTo = returnTo;
    farmUi.inventoryMode = mode;

    // 기존 인벤토리 패널이 있으면 삭제한다.
    if (farmUi.inventoryPanelMessage) {
        try {
            await farmUi.inventoryPanelMessage.delete();
        } catch (error) {
        }
    }

    const inventory = getInventory(user.id);
    const inventorySlots = buildInventorySlots(inventory);

    // 새 인벤토리 패널을 보내고 저장한다.
    farmUi.inventoryPanelMessage = await channel.send({
        content: `${user.username}님의 인벤토리`,
        components: createInventoryRows(inventorySlots)
    });
}


function createFarmEmbed(user, farm, userData, inventory) {
    const embed = new EmbedBuilder()
        .setTitle(`${user.username}님의 농장`)
        .setDescription(renderPlots(farm.plots))
        .addFields(
            { name: '연도', value: `${farm.year}년차`, inline: true },
            { name: '계절', value: farm.season, inline: true },
            { name: '날짜', value: `${farm.day}일차`, inline: true },
            { name: '시간', value: `${getTimeLabel(farm.time_minutes)} ${formatTime(farm.time_minutes)}`, inline: true },
            { name: '날씨', value: farm.weather, inline: true },
            { name: '코인', value: `${userData.coins}G`, inline: true }
        )
        .setColor(0x6ab04c);

    if (farm.inventory_open === 1) {
        embed.addFields({
            name: '인벤토리',
            value: renderInventory(inventory),
            inline: true
        });
    }

    return embed;
}

function createFarmControlRow(farm) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('farm_shop')
            .setLabel('상점')
            .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
            .setCustomId('farm_mode_plant')
            .setLabel('심기')
            .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
            .setCustomId('farm_mode_harvest')
            .setLabel('수확')
            .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId('farm_sleep')
            .setLabel('잠자기')
            .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId('farm_inventory_open')
            .setLabel('인벤토리')
            .setStyle(ButtonStyle.Secondary)
    );
}


async function sendFarmPanel(channel, user) {
    stopFarmRealtime();// 매시지 패널을 생성할때마다 타이머를 끔 -> 아래에 타이머를 생성하는 코드가 있음
    //즉 A용 타이머 끄기, A 삭제, B 생성 ,B용 타이머 켜기

    if (farmUi.farmPanelMessage) {
        try {
            await farmUi.farmPanelMessage.delete();
        } catch (error) {
        }

        farmUi.farmPanelMessage = null;
        farmUi.farmPanelUser = null;
    }

    ensureUser(user);
    ensureFarm(user.id);

    updateFarmTime(user.id);
    growCrops(user.id);

    const farm = getFarm(user.id);
    const userData = getUser(user.id);
    const inventory = getInventory(user.id);

    farmUi.farmPanelMessage = await channel.send({
        embeds: [createFarmEmbed(user, farm, userData, inventory)],
        components: [
            ...createPlotRows(farm),
            createFarmControlRow(farm)
        ]
    });

    // 실시간 갱신할 때 어떤 유저의 농장을 수정할지 기억한다.
    farmUi.farmPanelUser = user;

    // 농장 패널이 열린 뒤 1초마다 같은 메시지를 edit으로 수정한다.
    startFarmRealtime();
}


// 현재 농장 패널을 DB 최신 상태로 다시 그린다.
async function refreshFarmPanelRealtime() {
    if (!farmUi.farmPanelMessage || !farmUi.farmPanelUser) return;

    const user = farmUi.farmPanelUser;

    try {
        ensureUser(user);
        ensureFarm(user.id);

        // DB의 농장 시간을 현재 시간 기준으로 갱신한다.
        updateFarmTime(user.id);

        // 시간이 흐른 만큼 작물 성장 상태를 갱신한다.
        growCrops(user.id);

        const farm = getFarm(user.id);
        const userData = getUser(user.id);
        const inventory = getInventory(user.id);

        // 기존 메시지를 삭제하지 않고 수정한다.
        await farmUi.farmPanelMessage.edit({
            embeds: [createFarmEmbed(user, farm, userData, inventory)],
            components: [
                ...createPlotRows(farm),
                createFarmControlRow(farm)
            ]
        });
        } catch (error) {
        if (error.code === 10008) {
            console.log('농장 패널 메시지가 삭제되어 실시간 갱신을 중지합니다.');

            farmUi.farmPanelMessage = null;
            farmUi.farmPanelUser = null;
            stopFarmRealtime();

            return;
        }

        console.error('농장 실시간 갱신 오류:', error);
    }
}

// 1초마다 농장 패널을 갱신한다.
function startFarmRealtime() {
    if (farmUi.farmRealtimeTimer) return;

    farmUi.farmRealtimeTimer = setInterval(() => {
        refreshFarmPanelRealtime();
    }, 1000);
}

function stopFarmRealtime() {
    if (!farmUi.farmRealtimeTimer) return;

    clearInterval(farmUi.farmRealtimeTimer);
    farmUi.farmRealtimeTimer = null;
}


async function deleteFarmPanel() {
    stopFarmRealtime();

    if (farmUi.farmPanelMessage) {
        try {
            await farmUi.farmPanelMessage.delete();
        } catch (error) {
        }

        farmUi.farmPanelMessage = null;
        farmUi.farmPanelUser = null;
    }
}

async function refreshFarmPanel(interaction) {
    ensureUser(interaction.user);
    ensureFarm(interaction.user.id);

    const farm = updateFarmTime(interaction.user.id);
    const userData = getUser(interaction.user.id);
    const inventory = getInventory(interaction.user.id);

    await interaction.update({
        embeds: [createFarmEmbed(interaction.user, farm, userData, inventory)],
        components: [
            ...createPlotRows(farm),
            createFarmControlRow(farm)
        ]
    });
}

async function handleFarmMessage(message) {
    if (message.content === '농장' || message.content === '내농장') {
        ensureUser(message.author);
        ensureFarm(message.author.id);

        updateFarmTime(message.author.id);
        growCrops(message.author.id);

        await sendFarmPanel(message.channel, message.author);
        return true;
    }

    return false;
}


// 밭영역에 씨앗을 심는 함수
function isSeedItem(itemId) {
    return itemId && itemId.endsWith('_seed');
}

function getRange3x3Indexes(centerIndex) {
    const centerRow = Math.floor(centerIndex / 3);
    const centerCol = centerIndex % 3;

    const indexes = [];

    for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
        for (let colOffset = -1; colOffset <= 1; colOffset++) {
            const row = centerRow + rowOffset;
            const col = centerCol + colOffset;

            if (row < 0 || row >= 3) continue;
            if (col < 0 || col >= 3) continue;

            indexes.push(row * 3 + col);
        }
    }

    return indexes;
}

function plantSeedRange(userId, centerIndex) {
    const farm = getFarm(userId);

    if (!farm.selected_item) {
        return { message: '먼저 인벤토리에서 심을 씨앗을 선택해주세요.' };
    }

    if (!isSeedItem(farm.selected_item)) {
        return { message: '씨앗만 심을 수 있습니다.' };
    }

    const inventory = getInventory(userId);
    const seedItem = inventory.find(item => item.item_id === farm.selected_item);

    if (!seedItem || seedItem.quantity <= 0) {
        return { message: '선택한 씨앗이 인벤토리에 없습니다.' };
    }

    const plots = farm.plots.split(',');

    // 클릭한 밭을 중심으로 3x3 범위를 구한다.
    // 밭 밖으로 나가는 칸은 자동으로 제외된다.
    const targetIndexes = getRange3x3Indexes(centerIndex);

    // 이미 심어진 칸은 제외하고, 빈 칸에만 심는다.
    const emptyIndexes = targetIndexes.filter(index => plots[index] === 'empty');

    if (emptyIndexes.length === 0) {
        return { message: '심을 수 있는 빈 밭이 없습니다.' };
    }

    // 씨앗 1개로 범위 안의 빈 밭들을 모두 심는다.
    const plantedTimes = farm.plot_planted_at.split(',').map(Number);//db에 저장된 "밭별 심은 시간 문자열"을 숫자 배열로 바꾼다.
    const currentMinutes = getCurrentFarmMinutes(farm);//현재 농장시간을 몇분인지 계산한다.(ex.1일차 오전 6시--> 360분)


    
    console.log('--- 씨앗 심기 로그 ---');
    console.log('클릭한 밭 번호:', centerIndex + 1);
    console.log('선택한 씨앗:', farm.selected_item);
    console.log('심어진 밭 번호:', emptyIndexes.map(index => index + 1).join(', '));
    console.log('심은 시간:', currentMinutes);

    emptyIndexes.forEach(index => {
        plots[index] = farm.selected_item;
        plantedTimes[index] = currentMinutes;
    });

    db.prepare(`
        UPDATE farms
        SET plots = ?,
            plot_planted_at = ?
        WHERE discord_user_id = ?
    `).run(plots.join(','), plantedTimes.join(','), userId);

    // 씨앗은 딱 1개만 소비한다.
    removeInventoryItem(userId, farm.selected_item, 1);

    return {
        message: `${emptyIndexes.length}칸에 씨앗을 심었습니다. 씨앗 1개를 사용했습니다.`
    };
}

////---- 성장관련 함수와 변수들----
const CROP_GROWING_MINUTES = 60;
const CROP_READY_MINUTES = 180;

function getCurrentFarmMinutes(farm) {
    const seasonIndex = getSeasonIndex(farm.season); //현재 계절이 몇번째 계절 인지를 구한다 봄=0, 여름=1, 가을=2, 겨울=3

    const totalDays =
        (farm.year - 1) * DAYS_PER_SEASON * seasons.length +//이전 년도들이 가진 총 날짜의수 1년차면 ->0일일걸, 2년차면 ->112일??
        seasonIndex * DAYS_PER_SEASON + // 한연도내에서 지나간 날짜
        (farm.day - 1);//현재 계절에서 지나간 날

    return totalDays * MINUTES_PER_DAY + farm.time_minutes;// totalDays * MINUTES_PER_DAY날짜를 분으로 바꾸는,게임시작후 몇분 지났는가
}

function getGrowingState(seedItemId) {
    return seedItemId.replace('_seed', '_growing');
}

function getReadyState(seedItemId) {
    return seedItemId.replace('_seed', '_ready');
}
//작물 성장 함수)
function growCrops(userId) {
    const farm = getFarm(userId);

    const plots = farm.plots.split(',');
    const plantedTimes = farm.plot_planted_at.split(',').map(Number);
    const currentMinutes = getCurrentFarmMinutes(farm);

    let changed = false;

    for (let i = 0; i < plots.length; i++) {
        const plot = plots[i];
        const plantedAt = plantedTimes[i];

        if (plantedAt === -1) continue;

        const age = currentMinutes - plantedAt;

        if (plot.endsWith('_seed') && age >= CROP_GROWING_MINUTES) {
            plots[i] = getGrowingState(plot);
            changed = true;
        }

        if (plot.endsWith('_growing') && age >= CROP_READY_MINUTES) {
            const seedName = plot.replace('_growing', '_seed');
            plots[i] = getReadyState(seedName);
            changed = true;
        }
    }

    if (changed) {
        db.prepare(`
            UPDATE farms
            SET plots = ?
            WHERE discord_user_id = ?
        `).run(plots.join(','), userId);
    }
}

// 수확 가능한 작물을 전부 수확한다.
// _ready 상태인 작물만 수확하고, 작물 종류별로 인벤토리에 넣는다.
function harvestReadyCrops(userId) {
    const farm = getFarm(userId);
    const plots = farm.plots.split(',');
    const plantedTimes = farm.plot_planted_at.split(',').map(Number);

    const harvestCounts = {};

    for (let i = 0; i < plots.length; i++) {
        const plot = plots[i];

        // 수확 가능 상태가 아니면 건너뛴다.
        if (!plot.endsWith('_ready')) continue;

        // wheat_ready -> wheat
        // potato_ready -> potato
        const cropItemId = plot.replace('_ready', '');

        harvestCounts[cropItemId] = (harvestCounts[cropItemId] || 0) + 1;

        // 수확한 밭은 비운다.
        plots[i] = 'empty';
        plantedTimes[i] = -1;
    }

    const harvestedItems = Object.entries(harvestCounts);

    if (harvestedItems.length === 0) {
        return {
            harvested: false,
            message: '수확 가능한 작물이 없습니다.'
        };
    }

    harvestedItems.forEach(([itemId, quantity]) => {
        addInventoryItem(userId, itemId, quantity);
    });

    db.prepare(`
        UPDATE farms
        SET plots = ?,
            plot_planted_at = ?
        WHERE discord_user_id = ?
    `).run(plots.join(','), plantedTimes.join(','), userId);

    return {
        harvested: true,
        message: harvestedItems
            .map(([itemId, quantity]) => `${getCropName(itemId)} ${quantity}개`)
            .join(', ')
    };
}
// 작물 이름 함수
function getCropName(itemId) {
    const cropNames = {
        wheat: '밀',
        potato: '감자',
        carrot: '당근',
        strawberry: '딸기'
    };

    return cropNames[itemId] || itemId;
}

////---- 모달,버튼 관련 함수 처리하는 곳---
async function handleFarmInteraction(interaction) {

    // 모달 제출은 버튼이 아니기 때문에 버튼 검사보다 먼저 처리해야 한다.
    // 예: 판매 수량 입력창에서 확인 버튼을 눌렀을 때 이 코드가 실행된다.
    if (interaction.isModalSubmit() && interaction.customId === 'farm_sell_quantity_modal') {
        const draft = getSellDraft(interaction.user.id);

        // 판매할 아이템을 선택하지 않은 상태라면 처리할 수 없다.
        if (!draft) {
            await interaction.reply('판매할 아이템을 먼저 선택해주세요.');
            return true;
        }

        // 모달 입력창에서 사용자가 입력한 판매 수량을 가져온다.
        const rawQuantity = interaction.fields.getTextInputValue('sell_quantity');

        // 입력값은 문자열이므로 숫자로 변환한다.
        const quantity = Number(rawQuantity);

        // 숫자가 아니거나 1보다 작으면 잘못된 입력으로 처리한다.
        if (!Number.isInteger(quantity) || quantity <= 0) {
            await interaction.reply('수량은 1 이상의 숫자로 입력해주세요.');
            return true;
        }

        // 현재 인벤토리에서 선택한 아이템의 보유 수량을 확인한다.
        const inventory = getInventory(interaction.user.id);
        const inventoryItem = inventory.find(item => item.item_id === draft.itemId);

        // 아이템이 없으면 최대 수량을 1로 둔다.
        // 보통은 이 상황이 거의 없지만, 안전장치로 둔다.
        const maxQuantity = inventoryItem ? inventoryItem.quantity : 1;

        // 입력한 수량이 보유 수량보다 크면 보유 수량까지만 허용한다.
        const safeQuantity = Math.min(quantity, maxQuantity);

        // 판매 임시 정보에 최종 판매 수량을 저장한다.
        setSellDraft(interaction.user.id, draft.itemId, safeQuantity);

        // 판매 패널 메시지를 새 수량 기준으로 갱신한다.
        await interaction.update({
            content: createSellContent(interaction.user.id),
            components: createSellRows()
        });

        return true;
    }

    // 여기부터는 버튼 전용 처리다.
    // 모달은 버튼이 아니므로, 이 검사는 모달 처리 이후에 해야 한다.
    if (!interaction.isButton()) return false;

    // 농장 관련 버튼이 아니면 이 모듈에서 처리하지 않는다.
    if (!interaction.customId.startsWith('farm_')) return false;

    ensureUser(interaction.user);
    ensureFarm(interaction.user.id);
    updateFarmTime(interaction.user.id);
    growCrops(interaction.user.id);
    //시간이 흐를때 성장함수 실행

    if (interaction.customId === 'farm_inventory_open') {
        await interaction.reply('인벤토리를 열었습니다.');

        await sendFarmPanel(interaction.channel, interaction.user);
        await sendInventoryPanel(interaction.channel, interaction.user);
        return true;
    }

    if (interaction.customId === 'farm_inventory_close') {
        await interaction.message.delete();

        farmUi.inventoryPanelMessage = null;

        if (farmUi.inventoryReturnTo === 'shop') {
            await sendShopPanel(interaction.channel, interaction.user);
        } else {
            await sendFarmPanel(interaction.channel, interaction.user);
        }

        return true;
    }

    // 인벤토리 슬롯 버튼을 클릭했을 때 처리한다.
    if (interaction.customId.startsWith('farm_inventory_slot_')) {
        const slotIndex = Number(interaction.customId.replace('farm_inventory_slot_', ''));
        const inventory = getInventory(interaction.user.id);
        const inventorySlots = buildInventorySlots(inventory);
        const selectedSlot = inventorySlots[slotIndex];

        if (!selectedSlot) {
            await interaction.reply('빈 인벤토리 칸입니다.');

            await sendFarmPanel(interaction.channel, interaction.user);
            return true;
        }

        // 판매 모드에서 인벤토리 아이템을 클릭했을 때 처리한다.
        // 선택한 아이템으로 판매 패널을 연다.
        if (farmUi.inventoryMode === 'sell') {
            const sellInfo = getItemSellInfo(selectedSlot.itemId);

            if (!sellInfo) {
                await interaction.reply('이 아이템은 판매할 수 없습니다.');
                return true;
            }

            await interaction.reply(`${sellInfo.name} 판매를 선택했습니다.`);

            await interaction.message.delete();
            farmUi.inventoryPanelMessage = null;

            await sendSellPanel(interaction.channel, interaction.user, selectedSlot.itemId);
            return true;
        }


        db.prepare(`
            UPDATE farms
            SET selected_item = ?
            WHERE discord_user_id = ?
        `).run(selectedSlot.itemId, interaction.user.id);

        await interaction.reply(`${selectedSlot.label}을 선택했습니다.`);

        await sendFarmPanel(interaction.channel, interaction.user);
        return true;
    }

    // 밭 버튼을 클릭했을 때 처리한다.
    if (interaction.customId.startsWith('farm_plot_')) {
        const plotIndex = Number(interaction.customId.replace('farm_plot_', ''));
        const farm = getFarm(interaction.user.id);

        if (farm.mode === 'plant') {
            const result = plantSeedRange(interaction.user.id, plotIndex);

            await interaction.reply(result.message);

            await sendFarmPanel(interaction.channel, interaction.user);
            return true;
        }

        if (farm.mode === 'harvest') {
            await interaction.reply('수확 기능은 아직 준비 중입니다.');

            await sendFarmPanel(interaction.channel, interaction.user);
            return true;
        }

        await interaction.reply('먼저 `심기` 또는 `수확` 모드를 선택해주세요.');

        await sendFarmPanel(interaction.channel, interaction.user);
        return true;
    } 


    if (interaction.customId === 'farm_shop') {
        await interaction.reply('상점을 열었습니다.');

        await deleteFarmPanel();
        await sendShopPanel(interaction.channel, interaction.user);
        return true;
    }

    // 상점 닫기
    if (interaction.customId === 'farm_shop_close') {
        await interaction.message.delete();
        farmUi.shopPanelMessage = null;

        await sendFarmPanel(interaction.channel, interaction.user);
        return true;
    }

    if (interaction.customId === 'farm_shop_sell') {
        await interaction.reply('판매할 아이템을 선택하세요.');

        if (farmUi.shopPanelMessage) {
            try {
                await farmUi.shopPanelMessage.delete();
            } catch (error) {
            }

            farmUi.shopPanelMessage = null;
        }

        await sendInventoryPanel(interaction.channel, interaction.user, 'shop', 'sell');
        return true;
    }



    // 상점에서 씨앗 종류를 선택했을 때
    if (interaction.customId.startsWith('farm_shop_item_')) {
        const itemId = interaction.customId.replace('farm_shop_item_', '');

        if (!shopItems[itemId]) {
            await interaction.reply('존재하지 않는 씨앗입니다.');
            return true;
        }

        await interaction.reply(`${shopItems[itemId].name}을 선택했습니다.`);
        await sendPurchasePanel(interaction.channel, interaction.user, itemId);
        return true;
    }

    // 구매 수량 증가
    if (interaction.customId === 'farm_purchase_increase') {
        const draft = getPurchaseDraft(interaction.user.id);

        if (!draft) {
            await interaction.reply('구매할 씨앗을 먼저 선택해주세요.');
            return true;
        }

        draft.quantity += 1;
        setPurchaseDraft(interaction.user.id, draft.itemId, draft.quantity);

        await interaction.update({
            content: createPurchaseContent(interaction.user.id),
            components: createPurchaseRows()
        });

        return true;
    }

    // 구매 수량 감소
    if (interaction.customId === 'farm_purchase_decrease') {
        const draft = getPurchaseDraft(interaction.user.id);

        if (!draft) {
            await interaction.reply('구매할 씨앗을 먼저 선택해주세요.');
            return true;
        }

        draft.quantity = Math.max(1, draft.quantity - 1);
        setPurchaseDraft(interaction.user.id, draft.itemId, draft.quantity);

        await interaction.update({
            content: createPurchaseContent(interaction.user.id),
            components: createPurchaseRows()
        });

        return true;
    }

    // 구매 취소
    if (interaction.customId === 'farm_purchase_cancel') {
        farmUi.purchaseDrafts.delete(interaction.user.id);

        await interaction.message.delete();
        farmUi.purchasePanelMessage = null;

        return true;
    }

    // 구매 확정
    if (interaction.customId === 'farm_purchase_confirm') {
        const draft = getPurchaseDraft(interaction.user.id);

        if (!draft) {
            await interaction.reply('구매할 씨앗을 먼저 선택해주세요.');
            return true;
        }

        const item = shopItems[draft.itemId];
        const totalPrice = item.price * draft.quantity;
        const userData = getUser(interaction.user.id);

        if (userData.coins < totalPrice) {
            await interaction.reply(`코인이 부족합니다. 필요: ${totalPrice}G / 보유: ${userData.coins}G`);
            return true;
        }

        db.prepare(`
        UPDATE users
        SET coins = coins - ?
        WHERE discord_user_id = ?
    `).run(totalPrice, interaction.user.id);

        addInventoryItem(interaction.user.id, draft.itemId, draft.quantity);

        farmUi.purchaseDrafts.delete(interaction.user.id);

        await interaction.update({
            content: `${item.emoji} ${item.name} ${draft.quantity}개를 구매했습니다. -${totalPrice}G`,
            components: []
        });


        await sendInventoryPanel(interaction.channel, interaction.user, 'shop');
        return true;
    }

    // 판매 수량 증가 버튼을 눌렀을 때 처리한다.
    // 보유 수량보다 많이 선택하지 못하게 제한한다.
    if (interaction.customId === 'farm_sell_increase') {
        const draft = getSellDraft(interaction.user.id);

        if (!draft) {
            await interaction.reply('판매할 아이템을 먼저 선택해주세요.');
            return true;
        }

        const inventory = getInventory(interaction.user.id);
        const inventoryItem = inventory.find(item => item.item_id === draft.itemId);
        const maxQuantity = inventoryItem ? inventoryItem.quantity : 1;

        draft.quantity = Math.min(maxQuantity, draft.quantity + 1);
        setSellDraft(interaction.user.id, draft.itemId, draft.quantity);

        await interaction.update({
            content: createSellContent(interaction.user.id),
            components: createSellRows()
        });

        return true;
    }

    // 판매 수량 감소 버튼을 눌렀을 때 처리한다.
    // 수량은 최소 1개로 유지한다.
    if (interaction.customId === 'farm_sell_decrease') {
        const draft = getSellDraft(interaction.user.id);

        if (!draft) {
            await interaction.reply('판매할 아이템을 먼저 선택해주세요.');
            return true;
        }

        draft.quantity = Math.max(1, draft.quantity - 1);
        setSellDraft(interaction.user.id, draft.itemId, draft.quantity);

        await interaction.update({
            content: createSellContent(interaction.user.id),
            components: createSellRows()
        });

        return true;
    }

    //수량 입력버튼 처리
    if (interaction.customId === 'farm_sell_quantity_open') {
        const draft = getSellDraft(interaction.user.id);

        if (!draft) {
            await interaction.reply('판매할 아이템을 먼저 선택해주세요.');
            return true;
        }

        await interaction.showModal(createSellQuantityModal(draft.quantity));
        return true;
    }
    

    // 판매 취소 버튼을 눌렀을 때 처리한다.
    // 판매 패널을 닫고 상점 패널로 돌아간다.
    if (interaction.customId === 'farm_sell_cancel') {
        farmUi.sellDrafts.delete(interaction.user.id);

        await interaction.message.delete();
        farmUi.sellPanelMessage = null;

        await sendShopPanel(interaction.channel, interaction.user);
        return true;
    }

    // 판매 확정 버튼을 눌렀을 때 처리한다.
    // 인벤토리 수량을 줄이고, 유저에게 코인을 지급한 뒤 상점으로 돌아간다.
    if (interaction.customId === 'farm_sell_confirm') {
        const draft = getSellDraft(interaction.user.id);

        if (!draft) {
            await interaction.reply('판매할 아이템을 먼저 선택해주세요.');
            return true;
        }

        const item = getItemSellInfo(draft.itemId);
        const inventory = getInventory(interaction.user.id);
        const inventoryItem = inventory.find(row => row.item_id === draft.itemId);

        if (!inventoryItem || inventoryItem.quantity < draft.quantity) {
            await interaction.reply('판매할 수량이 부족합니다.');
            return true;
        }

        const totalPrice = item.price * draft.quantity;

        removeInventoryItem(interaction.user.id, draft.itemId, draft.quantity);

        db.prepare(`
            UPDATE users
            SET coins = coins + ?
            WHERE discord_user_id = ?
        `).run(totalPrice, interaction.user.id);

        farmUi.sellDrafts.delete(interaction.user.id);

        await interaction.update({
            content: `${item.emoji} ${item.name} ${draft.quantity}개를 판매했습니다. +${totalPrice}G`,
            components: []
        });

        await sendShopPanel(interaction.channel, interaction.user);
        return true;
    }



    if (interaction.customId === 'farm_mode_plant') {
        await interaction.reply('심기 모드로 변경했습니다.');

        db.prepare(`
            UPDATE farms
            SET mode = 'plant'
            WHERE discord_user_id = ?
        `).run(interaction.user.id);


        await sendFarmPanel(interaction.channel, interaction.user);
        return true;
    }

    if (interaction.customId === 'farm_mode_harvest') {
        const result = harvestReadyCrops(interaction.user.id);

        if (!result.harvested) {
            await interaction.reply('수확 가능한 작물이 없습니다.');

            await sendFarmPanel(interaction.channel, interaction.user);
            return true;
        }

        
        await interaction.reply(`수확 완료! ${result.message}를 얻었습니다.`);

        await sendFarmPanel(interaction.channel, interaction.user);
        return true;
    }

    if (interaction.customId === 'farm_sleep') {
        await interaction.reply('잠자기 기능은 아직 준비 중입니다.');

        await sendFarmPanel(interaction.channel, interaction.user);
        return true;
    }

    return false;
}

module.exports = {
    handleFarmMessage,
    handleFarmInteraction
};