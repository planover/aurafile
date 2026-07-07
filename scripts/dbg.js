const fs = require('fs-extra');
const os = require('os');
const path = require('path');
process.env.AURAFILE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'r-'));
process.env.AURAFILE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'd-'));
const cfg = require('../src/config');
const fsops = require('../src/fsops');
(async () => {
  fs.writeFileSync(path.join(cfg.ROOT, 'note.md'), 'md');
  console.log('before trash exists?', fs.existsSync(path.join(cfg.ROOT, 'note.md')));
  const t = await fsops.trash('note.md');
  console.log('trash result', JSON.stringify(t), 'root has note?', fs.existsSync(path.join(cfg.ROOT, 'note.md')));
  const list = await fsops.listTrash();
  console.log('trash list', JSON.stringify(list));
  const u = await fsops.undo();
  console.log('undo result', JSON.stringify(u), 'root has note?', fs.existsSync(path.join(cfg.ROOT, 'note.md')));
})();
