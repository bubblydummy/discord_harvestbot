const { Client, Events, GatewayIntentBits, MessageFlags } = require('discord.js');
const { token } = require('./config.json');
const { handleRpsMessage, handleRpsInteraction } = require('./rps');
const { handleFarmMessage, handleFarmInteraction } = require('./farm');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

client.once(Events.ClientReady, readyClient => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (await handleRpsMessage(message)) return;
    if (await handleFarmMessage(message)) return;

    if (message.content === 'ping') {
        message.reply('pong');
    }
});

//버튼 클릭 이벤트 추가
client.on(Events.InteractionCreate, async interaction => {
    try {
        if (await handleRpsInteraction(interaction)) return;
        if (await handleFarmInteraction(interaction)) return;
    } catch (error) {
        console.error(error);

        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: '버튼 처리 중 오류가 발생했습니다.'
            });
        }
    }
});


client.login(token);