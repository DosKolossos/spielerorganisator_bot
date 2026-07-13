require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Collection,
  MessageFlags
} = require('discord.js');
const cron = require('node-cron');

const pingCommand = require('./commands/ping');
const profilCommand = require('./commands/profil');
const abwesenheitCommand = require('./commands/abwesenheit');
const regelCommand = require('./commands/regel');
const spielterminCommand = require('./commands/spieltermin');
const adminCommand = require('./commands/admin');
const geburtstagCommand = require('./commands/geburtstag');
const verfuegbarkeitCommand = require('./commands/verfuegbarkeit');
const standinCommand = require('./commands/standin');
const teamCommand = require('./commands/team');

const { runSundayReminder } = require('./jobs/sundayReminder');
const { runSundayPlanner } = require('./jobs/sundayPlanner');
const { runBirthdayReminder } = require('./jobs/birthdayReminder');
const { listTeams } = require('./services/teamService');
const { syncAllDiscordScheduledEvents } = require('./services/discordScheduledEventService');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.commands = new Collection();
client.commands.set(pingCommand.data.name, pingCommand);
client.commands.set(profilCommand.data.name, profilCommand);
client.commands.set(abwesenheitCommand.data.name, abwesenheitCommand);
client.commands.set(regelCommand.data.name, regelCommand);
client.commands.set(spielterminCommand.data.name, spielterminCommand);
client.commands.set(adminCommand.data.name, adminCommand);
client.commands.set(geburtstagCommand.data.name, geburtstagCommand);
client.commands.set(verfuegbarkeitCommand.data.name, verfuegbarkeitCommand);
client.commands.set(standinCommand.data.name, standinCommand);
client.commands.set(teamCommand.data.name, teamCommand);

async function registerCommands() {
  const commands = [
    pingCommand.data.toJSON(),
    profilCommand.data.toJSON(),
    abwesenheitCommand.data.toJSON(),
    regelCommand.data.toJSON(),
    spielterminCommand.data.toJSON(),
    adminCommand.data.toJSON(),
    geburtstagCommand.data.toJSON(),
    verfuegbarkeitCommand.data.toJSON(),
    standinCommand.data.toJSON(),
    teamCommand.data.toJSON()
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

function registerCronJobs(client) {
  cron.schedule(
    '30 18 * * 0',
    async () => {
      console.log('[Cron] Starte Sunday Reminder...');
      await runSundayReminder(client);
    },
    { timezone: 'Europe/Berlin' }
  );

  cron.schedule(
    '0 20 * * 0',
    async () => {
      console.log('[Cron] Starte Sunday Planner...');
      for (const team of listTeams()) {
        try {
          await runSundayPlanner(client, { teamId: team.id });
        } catch (error) {
          console.error(`[Cron] Sunday Planner für Team ${team.id} fehlgeschlagen:`, error);
        }
      }
    },
    { timezone: 'Europe/Berlin' }
  );

    cron.schedule(
    '0 9 * * *',
    async () => {
      console.log('[Cron] Starte Birthday Reminder...');
      await runBirthdayReminder(client);
    },
    { timezone: 'Europe/Berlin' }
  );

  cron.schedule(
    '*/15 * * * *',
    async () => {
      try {
        const summary = await syncAllDiscordScheduledEvents(client);
        if (summary.created || summary.updated || summary.deleted || summary.errors) {
          console.log('[Cron] Discord-Events synchronisiert:', summary);
        }
      } catch (error) {
        console.error('[Cron] Discord-Event-Synchronisierung fehlgeschlagen:', error);
      }
    },
    { timezone: 'Europe/Berlin' }
  );

  console.log('Cronjobs registriert.');
}

client.once('clientReady', async () => {
  console.log(`Eingeloggt als ${client.user.tag}`);
  await registerCommands();

  try {
    const summary = await syncAllDiscordScheduledEvents(client);
    console.log('[Discord-Event] Start-Synchronisierung abgeschlossen:', summary);
  } catch (error) {
    console.error('[Discord-Event] Start-Synchronisierung fehlgeschlagen:', error);
  }

  try {
    const refreshedCards = await spielterminCommand.refreshAllStoredAdminCards(client);
    console.log(`[Spieltermin] ${refreshedCards} gespeicherte Admin-Karten aktualisiert.`);
  } catch (error) {
    console.error('[Spieltermin] Gespeicherte Admin-Karten konnten beim Start nicht aktualisiert werden:', error);
  }

  registerCronJobs(client);
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
      if (spielterminCommand.canHandleInteraction?.(interaction)) {
        await spielterminCommand.handleInteraction(interaction);
        return;
      }

      if (verfuegbarkeitCommand.canHandleInteraction?.(interaction)) {
        await verfuegbarkeitCommand.handleInteraction(interaction);
        return;
      }

      if (adminCommand.canHandleInteraction?.(interaction)) {
        await adminCommand.handleInteraction(interaction);
        return;
      }
    }
  } catch (error) {
    console.error(error);

    const payload = {
      content: 'Beim Ausführen der Aktion ist ein Fehler aufgetreten.',
      flags: MessageFlags.Ephemeral
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => null);
    } else if (interaction.isRepliable()) {
      await interaction.reply(payload).catch(() => null);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
