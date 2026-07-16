const crypto = require('crypto');
const {
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus
} = require('discord.js');
const db = require('../db/database');
const { getTeamById } = require('./teamService');

const DISCORD_EVENT_ENTITY_TYPE_EXTERNAL = GuildScheduledEventEntityType.External;
const DISCORD_EVENT_PRIVACY_LEVEL_GUILD_ONLY = GuildScheduledEventPrivacyLevel.GuildOnly;
const DISCORD_EVENT_STATUS_SCHEDULED = GuildScheduledEventStatus.Scheduled;
const DISCORD_EVENT_STATUS_ACTIVE = GuildScheduledEventStatus.Active;
const DISCORD_EVENT_STATUS_COMPLETED = GuildScheduledEventStatus.Completed;
const DISCORD_EVENT_STATUS_CANCELED = GuildScheduledEventStatus.Canceled;
const DEFAULT_TIME_ZONE = 'Europe/Berlin';
const syncLocks = new Map();

function truncate(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function getEventById(eventId) {
  return db.prepare(`
    SELECT *
    FROM team_calendar_events
    WHERE id = ?
  `).get(eventId);
}

function getAssignments(eventId) {
  return db.prepare(`
    SELECT role_label, player_label, assignee_type
    FROM team_calendar_assignments
    WHERE event_id = ?
    ORDER BY CASE role_label
      WHEN 'Top' THEN 1
      WHEN 'Jgl' THEN 2
      WHEN 'Mid' THEN 3
      WHEN 'ADC' THEN 4
      WHEN 'Supp' THEN 5
      WHEN 'Sub1' THEN 6
      WHEN 'Sub2' THEN 7
      ELSE 99
    END, role_label ASC
  `).all(eventId);
}

function parseLocalDateTime(value) {
  const match = String(value || '').trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
  );

  if (!match) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0)
  };
}

function getTimeZoneOffsetMilliseconds(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  const representedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return representedAsUtc - date.getTime();
}

function berlinDateTimeToDate(value, timeZone = DEFAULT_TIME_ZONE) {
  const parts = parseLocalDateTime(value);
  if (!parts) return null;

  const wallClockAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  let result = new Date(wallClockAsUtc);
  let offset = getTimeZoneOffsetMilliseconds(result, timeZone);
  result = new Date(wallClockAsUtc - offset);

  const correctedOffset = getTimeZoneOffsetMilliseconds(result, timeZone);
  if (correctedOffset !== offset) {
    result = new Date(wallClockAsUtc - correctedOffset);
  }

  return Number.isNaN(result.getTime()) ? null : result;
}

function formatDateTimeDE(value) {
  const parts = parseLocalDateTime(value);
  if (!parts) return '-';

  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}.${parts.year}, ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')} Uhr`;
}

function eventTypeLabel(type) {
  switch (type) {
    case 'flex':
      return 'Flex';
    case 'scrim':
      return 'Scrim';
    case 'primeleague':
      return 'Prime League';
    case 'other':
      return 'Sonstiges';
    case 'open':
    default:
      return 'Offen';
  }
}

function isEligibleForDiscordEvent(event) {
  return Boolean(
    event &&
    Number(event.is_streamed) === 1 &&
    event.status === 'fixed' &&
    event.scheduled_start_at &&
    event.scheduled_end_at
  );
}

function buildEventName(event, team) {
  const teamName = team?.name || team?.short_name || 'Team';
  const opponent = String(event.opponent_name || '').trim();
  const type = eventTypeLabel(event.event_type);
  const matchup = opponent ? `${teamName} vs ${opponent}` : teamName;
  return truncate(`${type}: ${matchup}`, 100);
}

function buildLineupDescription(assignments) {
  const starters = ['Top', 'Jgl', 'Mid', 'ADC', 'Supp'];
  const byRole = new Map(assignments.map(item => [item.role_label, item]));

  return starters
    .map(role => {
      const item = byRole.get(role);
      if (!item) return `${role}: offen`;
      const standinSuffix = item.assignee_type === 'standin' ? ' (Stand-in)' : '';
      return `${role}: ${item.player_label}${standinSuffix}`;
    })
    .join('\n');
}

function buildEventDescription(event, team, assignments) {
  const lines = [
    `**${team?.name || 'Team'}**`,
    `Art: ${eventTypeLabel(event.event_type)}`,
    `Beginn: ${formatDateTimeDE(event.scheduled_start_at)}`,
    '',
    '**Aufstellung**',
    buildLineupDescription(assignments)
  ];

  if (event.opgg_url) {
    lines.push('', `Gegner OP.GG: ${event.opgg_url}`);
  }

  if (event.note) {
    lines.push('', `Hinweis: ${event.note}`);
  }

  return truncate(lines.join('\n'), 1000);
}

function buildScheduledEventOptions(event, team, assignments) {
  const scheduledStartTime = berlinDateTimeToDate(event.scheduled_start_at);
  const scheduledEndTime = berlinDateTimeToDate(event.scheduled_end_at);

  if (!scheduledStartTime || !scheduledEndTime || scheduledEndTime <= scheduledStartTime) {
    return null;
  }

  return {
    name: buildEventName(event, team),
    description: buildEventDescription(event, team, assignments),
    scheduledStartTime,
    scheduledEndTime,
    privacyLevel: DISCORD_EVENT_PRIVACY_LEVEL_GUILD_ONLY,
    entityType: DISCORD_EVENT_ENTITY_TYPE_EXTERNAL,
    entityMetadata: {
      location: truncate(`Livestream · ${team?.name || eventTypeLabel(event.event_type)}`, 100)
    },
    reason: `Automatisch synchronisiert aus gestreamtem Spieltermin #${event.id}`
  };
}

function buildSyncFingerprint(options) {
  const payload = {
    name: options.name,
    description: options.description,
    scheduledStartTime: options.scheduledStartTime.toISOString(),
    scheduledEndTime: options.scheduledEndTime.toISOString(),
    location: options.entityMetadata?.location || ''
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function updateSyncState(eventId, patch = {}) {
  const current = getEventById(eventId);
  if (!current) return;

  db.prepare(`
    UPDATE team_calendar_events
    SET discord_scheduled_event_id = ?,
        discord_scheduled_event_guild_id = ?,
        discord_scheduled_event_synced_at = ?,
        discord_scheduled_event_fingerprint = ?,
        discord_scheduled_event_error = ?
    WHERE id = ?
  `).run(
    Object.prototype.hasOwnProperty.call(patch, 'eventId')
      ? patch.eventId
      : current.discord_scheduled_event_id,
    Object.prototype.hasOwnProperty.call(patch, 'guildId')
      ? patch.guildId
      : current.discord_scheduled_event_guild_id,
    Object.prototype.hasOwnProperty.call(patch, 'syncedAt')
      ? patch.syncedAt
      : current.discord_scheduled_event_synced_at,
    Object.prototype.hasOwnProperty.call(patch, 'fingerprint')
      ? patch.fingerprint
      : current.discord_scheduled_event_fingerprint,
    Object.prototype.hasOwnProperty.call(patch, 'error')
      ? patch.error
      : current.discord_scheduled_event_error,
    eventId
  );
}

function clearScheduledEventReference(eventId, error = null) {
  updateSyncState(eventId, {
    eventId: null,
    guildId: null,
    syncedAt: new Date().toISOString(),
    fingerprint: null,
    error
  });
}

async function resolveGuild(client, event) {
  const guildId = event.discord_scheduled_event_guild_id || process.env.GUILD_ID;
  if (!guildId) {
    throw new Error('GUILD_ID fehlt. Das Discord-Event kann keinem Server zugeordnet werden.');
  }

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
  if (!guild) {
    throw new Error(`Discord-Server ${guildId} wurde nicht gefunden.`);
  }

  return guild;
}

function isUnknownScheduledEventError(error) {
  const code = error?.code ?? error?.rawError?.code;
  return error?.status === 404 || code === 10070;
}

async function fetchExistingScheduledEvent(guild, event) {
  if (!event.discord_scheduled_event_id) return null;

  try {
    return await guild.scheduledEvents.fetch({
      guildScheduledEvent: event.discord_scheduled_event_id,
      force: true
    });
  } catch (error) {
    if (isUnknownScheduledEventError(error)) {
      clearScheduledEventReference(event.id, null);
      return null;
    }

    throw error;
  }
}

async function deleteExistingScheduledEvent(client, event, reason = 'Termin ist nicht mehr als gestreamtes, fixes Ereignis markiert') {
  if (!event?.discord_scheduled_event_id) {
    return { action: 'none', eventId: event?.id ?? null };
  }

  try {
    const guild = await resolveGuild(client, event);

    try {
      await guild.scheduledEvents.delete(event.discord_scheduled_event_id);
    } catch (error) {
      if (!isUnknownScheduledEventError(error)) throw error;
    }

    clearScheduledEventReference(event.id, null);
    console.log(`[Discord-Event] Event für Spieltermin #${event.id} entfernt.`);
    return { action: 'deleted', eventId: event.id };
  } catch (error) {
    const message = truncate(error?.message || String(error), 1000);
    updateSyncState(event.id, { syncedAt: new Date().toISOString(), error: message });
    console.error(`[Discord-Event] Löschen für Spieltermin #${event.id} fehlgeschlagen:`, error);
    return { action: 'error', eventId: event.id, error: message };
  }
}

async function syncDiscordScheduledEventUnlocked(client, eventId) {
  let event = getEventById(eventId);
  if (!event) return { action: 'missing', eventId };

  if (!isEligibleForDiscordEvent(event)) {
    return deleteExistingScheduledEvent(client, event);
  }

  const team = getTeamById(event.team_id);
  const assignments = getAssignments(event.id);
  const options = buildScheduledEventOptions(event, team, assignments);

  if (!options) {
    const error = 'Fixe Start-/Endzeit ist ungültig oder die Endzeit liegt nicht nach dem Beginn.';
    updateSyncState(event.id, { syncedAt: new Date().toISOString(), error });
    return { action: 'skipped', eventId, reason: error };
  }

  const fingerprint = buildSyncFingerprint(options);
  const now = Date.now();
  if (options.scheduledEndTime.getTime() <= now) {
    return deleteExistingScheduledEvent(client, event, 'Termin liegt bereits in der Vergangenheit');
  }

  try {
    const guild = await resolveGuild(client, event);
    let existing = await fetchExistingScheduledEvent(guild, event);
    event = getEventById(eventId);

    if (!existing && options.scheduledStartTime.getTime() <= now + 60_000) {
      const error = 'Beginn liegt bereits in der Vergangenheit oder ist in weniger als einer Minute.';
      updateSyncState(event.id, { syncedAt: new Date().toISOString(), error });
      return { action: 'skipped', eventId, reason: error };
    }

    if (existing) {
      if (existing.status !== DISCORD_EVENT_STATUS_SCHEDULED) {
        if (
          existing.status === DISCORD_EVENT_STATUS_COMPLETED ||
          existing.status === DISCORD_EVENT_STATUS_CANCELED ||
          options.scheduledEndTime.getTime() <= now
        ) {
          clearScheduledEventReference(event.id, null);
          return { action: 'completed', eventId, discordEventId: existing.id };
        }

        if (existing.status === DISCORD_EVENT_STATUS_ACTIVE) {
          updateSyncState(event.id, {
            syncedAt: new Date().toISOString(),
            error: null
          });
          return { action: 'unchanged', eventId, discordEventId: existing.id };
        }

        updateSyncState(event.id, {
          syncedAt: new Date().toISOString(),
          error: null
        });
        return { action: 'unchanged', eventId, discordEventId: existing.id };
      }

      if (event.discord_scheduled_event_fingerprint === fingerprint) {
        updateSyncState(event.id, {
          syncedAt: new Date().toISOString(),
          error: null
        });
        return { action: 'unchanged', eventId, discordEventId: existing.id };
      }

      const updated = await guild.scheduledEvents.edit(existing.id, options);
      updateSyncState(event.id, {
        eventId: updated.id,
        guildId: guild.id,
        syncedAt: new Date().toISOString(),
        fingerprint,
        error: null
      });
      console.log(`[Discord-Event] Spieltermin #${event.id} mit Discord-Event ${updated.id} synchronisiert.`);
      return { action: 'updated', eventId, discordEventId: updated.id };
    }

    const created = await guild.scheduledEvents.create(options);
    updateSyncState(event.id, {
      eventId: created.id,
      guildId: guild.id,
      syncedAt: new Date().toISOString(),
      fingerprint,
      error: null
    });
    console.log(`[Discord-Event] Für Spieltermin #${event.id} wurde Discord-Event ${created.id} erstellt.`);
    return { action: 'created', eventId, discordEventId: created.id };
  } catch (error) {
    const message = truncate(error?.message || String(error), 1000);
    updateSyncState(event.id, { syncedAt: new Date().toISOString(), error: message });
    console.error(`[Discord-Event] Synchronisierung für Spieltermin #${event.id} fehlgeschlagen:`, error);
    return { action: 'error', eventId, error: message };
  }
}

async function syncDiscordScheduledEvent(client, eventId) {
  if (syncLocks.has(eventId)) return syncLocks.get(eventId);

  const promise = syncDiscordScheduledEventUnlocked(client, eventId)
    .finally(() => syncLocks.delete(eventId));

  syncLocks.set(eventId, promise);
  return promise;
}

async function deleteDiscordScheduledEvent(client, eventId) {
  const event = typeof eventId === 'object' ? eventId : getEventById(eventId);
  if (!event) return { action: 'missing', eventId: Number(eventId) || null };
  return deleteExistingScheduledEvent(client, event, 'Spieltermin wurde gelöscht');
}

async function syncAllDiscordScheduledEvents(client) {
  const events = db.prepare(`
    SELECT id
    FROM team_calendar_events
    WHERE discord_scheduled_event_id IS NOT NULL
       OR (
         is_streamed = 1
         AND status = 'fixed'
         AND scheduled_start_at IS NOT NULL
         AND scheduled_end_at IS NOT NULL
         AND option_date >= date('now', '-1 day')
       )
    ORDER BY option_date ASC, id ASC
  `).all();

  const summary = { checked: events.length, created: 0, updated: 0, deleted: 0, skipped: 0, errors: 0 };

  for (const row of events) {
    const result = await syncDiscordScheduledEvent(client, row.id);
    if (result.action === 'created') summary.created++;
    else if (result.action === 'updated') summary.updated++;
    else if (result.action === 'deleted') summary.deleted++;
    else if (result.action === 'error') summary.errors++;
    else if (result.action === 'skipped') summary.skipped++;
  }

  return summary;
}

function discordScheduledEventUrl(event) {
  const guildId = event?.discord_scheduled_event_guild_id || process.env.GUILD_ID;
  const discordEventId = event?.discord_scheduled_event_id;
  if (!guildId || !discordEventId) return null;
  return `https://discord.com/events/${guildId}/${discordEventId}`;
}

module.exports = {
  berlinDateTimeToDate,
  buildScheduledEventOptions,
  deleteDiscordScheduledEvent,
  discordScheduledEventUrl,
  isEligibleForDiscordEvent,
  syncAllDiscordScheduledEvents,
  syncDiscordScheduledEvent
};
