const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags
} = require('discord.js');

const { runSundayReminder } = require('../jobs/sundayReminder');
const { runSundayPlanner } = require('../jobs/sundayPlanner');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('admin')
        .setDescription('Admin-Testbefehle für den Spielerorganisator.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub =>
            sub
                .setName('test-reminder')
                .setDescription('Startet den Sonntags-Reminder sofort.')
        )
        .addSubcommand(sub =>
            sub
                .setName('test-planner')
                .setDescription('Startet den Sonntags-Planer sofort.')
        ),

    async execute(interaction) {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({
                content: 'Dafür fehlen dir die Rechte.',
                flags: MessageFlags.Ephemeral
            });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'test-reminder') {
            await interaction.reply({
                content: 'Starte Reminder-Test …',
                flags: MessageFlags.Ephemeral
            });

            try {
                const result = await runSundayReminder(interaction.client, { force: true });
                await interaction.followUp({
                    content: `Reminder-Test abgeschlossen.\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
                    flags: MessageFlags.Ephemeral
                });
            } catch (error) {
                console.error('[Admin] Reminder-Test fehlgeschlagen:', error);
                await interaction.followUp({
                    content: 'Reminder-Test ist fehlgeschlagen. Schau in die Railway-Logs.',
                    flags: MessageFlags.Ephemeral
                });
            }

            return;
        }
        if (subcommand === 'test-planner') {
            await interaction.reply({
                content: 'Starte Planner-Test …',
                flags: MessageFlags.Ephemeral
            });

            try {
                const result = await runSundayPlanner(interaction.client, { force: true });
                await interaction.followUp({
                    content: `Planner-Test abgeschlossen.\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
                    flags: MessageFlags.Ephemeral
                });
            } catch (error) {
                console.error('[Admin] Planner-Test fehlgeschlagen:', error);
                await interaction.followUp({
                    content: 'Planner-Test ist fehlgeschlagen. Schau in die Railway-Logs.',
                    flags: MessageFlags.Ephemeral
                });
            }
        }
    }
};
