// 「からもに」からアトリエ共通おたよりポストへ安全に進めることを確認。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const url = 'https://chibichan-sketchbook.daddyboubakiki.workers.dev/otayori/?app=karamoni';
const links = html.match(/<a\b[^>]*href="[^"]*\/otayori\/\?app=karamoni"[^>]*>おたよりポスト 📮<\/a>/g) || [];
assert.equal(links.length, 2, 'the practice-help dialog and page footer both have the link');
for (const link of links) {
  assert.ok(link.includes(`href="${url}"`));
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.match(link, /referrerpolicy="no-referrer"/);
}
const practiceEnd = html.indexOf('  </div><!-- practice -->');
const footer = html.indexOf('<footer class="feedback-footer"');
const settingsEnd = html.lastIndexOf('  </details>\n</div>\n\n<script>');
assert.ok(practiceEnd >= 0 && footer > practiceEnd, 'footer must not take space away from piano-roll practice');
assert.ok(settingsEnd >= 0 && footer < settingsEnd, 'footer stays within the app wrapper');
console.log('PASS: feedback links preserve the practice layout and disclose no referrer');
