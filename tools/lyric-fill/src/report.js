// 報告とエラーを日本語の文にする（CLI と、将来の画面で使う）

/** 自動で書けなかった理由の説明 */
export const REASON_TEXT = Object.freeze({
  protected: '先パートのこの小節には元から歌詞があるので、触らない（既存歌詞の保護）',
  onset_mismatch: '開始tickが違う（近くに音・歌詞があるが、ちょうど同じ位置ではない）',
  target_sustain: '先パートは前の音を伸ばしている（タイ・長い音）',
  target_rest: '先パートは休み',
  source_no_lyric: '元パートの音に歌詞がない（メリスマ・伸ばしの可能性）',
  source_rest: '元パートは休み',
  source_multi: '元パートの同じ位置に歌詞が複数ある',
});

/** ファイルやトラックを扱えない理由の説明 */
export const ERROR_TEXT = Object.freeze({
  not_midi: 'MIDIファイルではありません',
  truncated: 'ファイルが途中で切れています',
  bad_vlq: 'ファイルの中身が壊れています（時間の数値）',
  bad_running_status: 'ファイルの中身が壊れています（running status）',
  bad_data: 'ファイルの中身が壊れています（データ）',
  unsupported_event: 'MIDIファイルに入るはずのないデータがあります',
  format0: 'format 0（全パートが1トラック）のファイルは対象外です。歌詞はトラックごとに持つので、どのパートの歌詞か決められません',
  format_other: 'format 1 以外のファイルは対象外です',
  smpte: '時間の単位が SMPTE（秒の区切り）のファイルは対象外です',
  bad_division: 'ヘッダの時間の単位が 0 です',
  kar: 'カラオケ形式（.kar）は対象外です。カラモニは .kar のテキストも歌詞として読むので、歌詞が二重になります',
  bad_time_signature: '拍子の値が壊れています',
  no_such_track: 'そのトラック番号はありません',
  track_not_eligible: 'そのトラックは対象外です',
  no_targets: '写す先のパートを選んでください',
  duplicate_target: '写す先のパートが重なっています',
  target_is_source: '写す元と写す先が同じです',
  bad_bars: '小節の範囲が正しくありません',
  unsupported_edit: 'この編集はまだ扱えません',
  bad_edit: '編集の中身が正しくありません',
  duplicate_edit: '同じ位置に2つ書き足そうとしています',
  lyric_exists: 'その位置には元から歌詞があります',
  no_note_at_tick: 'その位置で始まる音がありません',
  verify_failed: '書き出したファイルの確認に失敗しました（保存しません）',
});

export const TRACK_REASON_TEXT = Object.freeze({
  no_notes: '音がない（曲名・テンポ用のトラックなど）',
  drums_only: '打楽器（ch10）だけ',
  multi_channel: '1トラックに複数のチャンネル（どのパートの歌詞か決められない）',
});

export function describeError(e) {
  const base = ERROR_TEXT[e && e.code];
  if (!base) return String(e && e.message || e);
  const m = /\((.*)\)$/.exec(e.message || '');
  return m ? `${base}（${m[1]}）` : base;
}

const pos = (x) => `${x.bar}小節${x.beat}拍`;

/** トラック一覧 */
export function formatTracks(song) {
  const lines = [`format ${song.format}、四分音符 = ${song.tpq} tick、最後の音は ${song.lastBar} 小節`];
  for (const t of song.tracks) {
    const lyrics = t.lyrics.length ? `歌詞 ${t.lyrics.length}` : '歌詞なし';
    if (t.eligible) lines.push(`  [${t.index}] ${t.name}（ch${t.channel + 1}、音 ${t.notes.length}、${lyrics}）`);
    else lines.push(`  [${t.index}] ${t.name} … 対象外：${TRACK_REASON_TEXT[t.reason] || t.reason}`);
  }
  return lines.join('\n');
}

/** 候補の報告 */
export function formatPlan(song, plan) {
  const { source, bars } = plan.options;
  const src = song.tracks[source];
  const lines = [
    `元パート：[${source}] ${src.name}（範囲内の歌詞 ${src.lyrics.filter((l) => l.bar >= bars.from && l.bar <= bars.to).length}）`,
    `範囲：${bars.from}〜${bars.to}小節`,
    '※ 開始tickが一致しても、音楽的に正しい歌詞とは限りません。カラモニで必ず確かめてください。',
  ];
  for (const r of plan.report) {
    lines.push('', `■ [${r.track}] ${r.name}：書き足す歌詞 ${r.added}`);
    lines.push(`  既存の歌詞がある小節（触らない）：${r.protectedBars.length ? r.protectedBars.join(', ') : 'なし'}`);
    const group = (title, items, withText) => {
      lines.push(`  ${title}：${items.length ? items.length : 'なし'}`);
      for (const x of items) {
        const extra = x.deltaTicks != null ? `（${x.deltaTicks > 0 ? '+' : ''}${x.deltaTicks} tick）` : '';
        lines.push(`    ${pos(x)}${withText ? `「${x.text}」` : ''}　${REASON_TEXT[x.reason] || x.reason}${extra}`);
      }
    };
    group('置けなかった元の歌詞', r.unplacedLyrics, true);
    group('歌詞が入らない先パートの音', r.unfilledNotes, false);
  }
  return lines.join('\n');
}
