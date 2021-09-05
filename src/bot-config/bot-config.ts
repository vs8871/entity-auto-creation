import *  as discort from 'discord.js';

export class DiscortBot {
    constructor() {
        const client = new discort.Client({ intents: ['GUILD_MESSAGES', 'GUILDS'] });
        client.on('ready', () => {
            console.log(`Logged in as ${client.user.tag}`);
        });

        client.login(process.env.CLIENT_TOKEN);
        return client;
    }
}