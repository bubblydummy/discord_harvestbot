 //작물/계절/상점 가격 같은 게임 설정 분리

const DAYS_PER_SEASON = 28;

const seasons = ['봄', '여름', '가을', '겨울'];

// 작물 관련 공통 데이터
const cropItems = {
    wheat: {
        name: '밀',
        emoji: '🌾',
        seedPrice: 10,
        growingMinutes: 30,
        readyMinutes: 90,
        regrowable: false
    },
    potato: {
        name: '감자',
        emoji: '🥔',
        seedPrice: 20,
        growingMinutes: 60,
        readyMinutes: 180,
        regrowable: false
    },
    carrot: {
        name: '당근',
        emoji: '🥕',
        seedPrice: 25,
        growingMinutes: 80,
        readyMinutes: 240,
        regrowable: false
    },
    strawberry: {
        name: '딸기',
        emoji: '🍓',
        seedPrice: 40,
        growingMinutes: 120,
        readyMinutes: 360,
        regrowable: true,
        regrowMinutes: 180
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

function getSeasonIndex(season) {
    const index = seasons.indexOf(season);
    return index === -1 ? 0 : index;
}

function getCropName(itemId) {
    const crop = cropItems[itemId];
    return crop ? crop.name : itemId;
}

module.exports = {
    DAYS_PER_SEASON,
    seasons,
    cropItems,
    shopItems,
    getSeasonIndex,
    getCropName
};