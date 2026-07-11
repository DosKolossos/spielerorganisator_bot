const {
  SlashCommandBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder
} = require('discord.js');
const { runSundayReminder } = require('../jobs/sundayReminder');
const { runSundayPlanner } = require('../jobs/sundayPlanner');
const { requireAdmin } = require('../utils/permissions');
const { resolveTeamForInteraction } = require('../services/teamService');
const {
  addDaysIso,
  getWeekStartDate,
  parseDateInput,
  normalizeRangeToFullWeeks,
  formatDateDE
} = require('../services/weeklyAvailabilityService');

const ADMIN_PREFIX = 'admin';

function buildPlannerRangeModal() {
  const startDate = getWeekStartDate();
  const endDate = addDaysIso(startDate, 13);

  const modal = new ModalBuilder()
    .setCustomId(`${ADMIN_PREFIX}:planner-range`)
    .setTitle('Planner-Zeitraum');

  const startInput = new TextInputBuilder()
    .setCustomId('start_date')
    .setLabel('Von-Datum (TT.MM.JJJJ oder JJJJ-MM-TT)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(formatDateDE(startDate))
    .setPlaceholder('z. B. 11.05.2026');

  const endInput = new TextInputBuilder()
    .setCustomId('end_date')
    .setLabel('Bis-Datum (TT.MM.JJJJ oder JJJJ-MM-TT)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(formatDateDE(endDate))
    .setPlaceholder('z. B. 24.05.2026');

  modal.addComponents(
    new ActionRowBuilder().addComponents(startInput),
    new ActionRowBuilder().addComponents(endInput)
  );

  return modal;
}

function canHandleInteraction(interaction) {
  return Boolean(interaction.customId && interaction.customId.startsWith(`${ADMIN_PREFIX}:`));
}

function buildPlannerResultMessage(result) {
  if (!result.sent) {
    return `Planner-Test abgeschlossen, aber nichts gesendet: ${result.reason || 'unbekannter Grund'}`;
  }

  return (
    `Planner-Test abgeschlossen.\n` +
    `Zeitraum: **${formatDateDE(result.startDate)} – ${formatDateDE(result.endDate)}**\n` +
    `Nachrichten/Karten: **${result.messages}**\n` +
    `Fehlzeiten: **${result.absenceCount}**\n` +
    `Vorschläge: **${result.suggestionCount}**\n` +
    `Termine: **${result.weekEventCount}**`
  );
}

async function handleInteraction(interaction) {
  if (!canHandleInteraction(interaction)) return false;

  if (!(await requireAdmin(interaction))) return true;

  const [prefix, action] = interaction.customId.split(':');
  if (prefix !== ADMIN_PREFIX) return false;

  if (interaction.isModalSubmit() && action === 'planner-range') {
    const startDate = parseDateInput(interaction.fields.getTextInputValue('start_date'));
    const endDate = parseDateInput(interaction.fields.getTextInputValue('end_date'));

    if (!startDate || !endDate) {
      await interaction.reply({
        content: 'Bitte gib gültige Datumswerte ein, z. B. `11.05.2026` oder `2026-05-11`.',
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    if (endDate < startDate) {
      await interaction.reply({
        content: 'Das Bis-Datum darf nicht vor dem Von-Datum liegen.',
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    const normalized = normalizeRangeToFullWeeks(startDate, endDate);
    const team = resolveTeamForInteraction(interaction);

    if (!team) {
      await interaction.reply({
        content: 'Für diesen Kanal konnte kein Team ermittelt werden.',
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = await runSundayPlanner(interaction.client, {
        force: true,
        teamId: team.id,
        startDate: normalized.startDate,
        endDate: normalized.endDate
      });

      await interaction.editReply({
        content: `**${team.name}**\n${buildPlannerResultMessage(result)}`
      });
    } catch (error) {
      console.error('[Admin] Planner-Test fehlgeschlagen:', error);
      await interaction.editReply({
        content: 'Planner-Test ist fehlgeschlagen. Schau in die Logs.'
      });
    }

    return true;
  }

  return false;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin-Testbefehle für den Spielerorganisator.')
    .addSubcommand(sub =>
      sub.setName('test-reminder').setDescription('Startet den Sonntags-Reminder sofort.')
    )
    .addSubcommand(sub =>
      sub.setName('test-planner').setDescription('Startet den Sonntags-Planer sofort mit auswählbarem Zeitraum.')
    ),

  canHandleInteraction,
  handleInteraction,

  async execute(interaction) {
    if (!(await requireAdmin(interaction))) return;

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'test-reminder') {
      await interaction.reply({ content: 'Starte Reminder-Test …', flags: MessageFlags.Ephemeral });
      try {
        const result = await runSundayReminder(interaction.client, { force: true });
        await interaction.followUp({
          content: `Reminder-Test abgeschlossen.\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('[Admin] Reminder-Test fehlgeschlagen:', error);
        await interaction.followUp({ content: 'Reminder-Test ist fehlgeschlagen. Schau in die Logs.', flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (subcommand === 'test-planner') {
      try {
        await interaction.showModal(buildPlannerRangeModal());
      } catch (error) {
        console.error('[Admin] Planner-Zeitraum-Modal konnte nicht geöffnet werden:', error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: 'Das Planner-Popup konnte nicht geöffnet werden. Schau in die Logs.',
            flags: MessageFlags.Ephemeral
          });
        }
      }
    }
  }
};
