import type { OperatorChangeFields } from './operator-change-recorder';

/**
 * What an operator change record may say about a library change (gaulatti/alcantara#236, slice 3): an instant,
 * stinger, song, media, media label or media group edited from the MCP or the console. A library item belongs to no
 * one program, so its record has no programId. Names, URLs, descriptions and the ids of a replaced list are only
 * named; numbers and booleans (and the size of a replaced list) keep their value before and after.
 */

export const INSTANT_CHANGE_FIELDS: OperatorChangeFields = {
  named: ['name', 'audioUrl'],
  valued: ['volume', 'enabled'],
};

export const STINGER_CHANGE_FIELDS: OperatorChangeFields = {
  named: ['name', 'videoUrl'],
  valued: ['cutPointMs', 'enabled'],
};

export const SONG_CHANGE_FIELDS: OperatorChangeFields = {
  named: [
    'artist',
    'title',
    'audioUrl',
    'coverUrl',
    // The song service names the legacy chart fields by these generic names before summarizing.
    'externalChartId',
    'externalChartSongId',
    'externalChartRank',
    'externalChartSpins',
    'externalChartProvider',
    'introInstantId',
  ],
  valued: ['durationMs', 'enabled'],
};

export const MEDIA_CHANGE_FIELDS: OperatorChangeFields = {
  named: ['name', 'imageUrl'],
  valued: [],
};

export const MEDIA_LABEL_CHANGE_FIELDS: OperatorChangeFields = {
  named: ['name', 'description'],
  valued: [],
};

/** The replaced list of a label: its ids are never copied; before and after carry the number of assets. */
export const MEDIA_LABEL_ASSETS_CHANGE_FIELDS: OperatorChangeFields = {
  named: [],
  valued: ['assetIds'],
};

/** A media group: before and after of `mediaIds` carry the number of media, never the ids. */
export const MEDIA_GROUP_CHANGE_FIELDS: OperatorChangeFields = {
  named: ['name', 'description'],
  valued: ['mediaIds'],
};
