const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages]
});

client.once("ready", () => {
  console.log(✅ Bot conectado como ${client.user.tag});
});

client.login(process.env.DISCORD_TOKEN);
