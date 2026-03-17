require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Collection
} = require('discord.js');

const pingCommand = require('./commands/ping');
const profilCommand = require('./commands/profil');
const abwesenheitCommand = require('./commands/abwesenheit');
const regelCommand = require('./commands/regel');
const urlaubCommand = require('./commands/urlaub');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.commands = new Collection();
client.commands.set(pingCommand.data.name, pingCommand);
client.commands.set(profilCommand.data.name, profilCommand);
client.commands.set(abwesenheitCommand.data.name, abwesenheitCommand);
client.commands.set(regelCommand.data.name, regelCommand);
client.commands.set(urlaubCommand.data.name, urlaubCommand);

async function registerCommands() {
  const commands = [
    pingCommand.data.toJSON(),
    profilCommand.data.toJSON(),
    abwesenheitCommand.data.toJSON(),
    regelCommand.data.toJSON(),
    urlaubCommand.data.toJSON()
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.GUILD_ID
    ),
    { body: commands }
  );

  console.log('Slash-Commands registriert.');
}

client.once('clientReady', async () => {
  console.log(`Eingeloggt als ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: 'Beim Ausführen des Commands ist ein Fehler aufgetreten.',
        ephemeral: true
      });
    } else {
      await interaction.reply({
        content: 'Beim Ausführen des Commands ist ein Fehler aufgetreten.',
        ephemeral: true
      });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);