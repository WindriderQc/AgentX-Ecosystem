'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(clipboard) {
  const Toast = { success: jest.fn(), error: jest.fn() };
  const context = { window: { location: { origin: 'https://my-agent.example:8443', search: '?status=blocked' } }, navigator: { clipboard },
    document: { addEventListener() {} }, URL, URLSearchParams, Toast };
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline.js'), 'utf8');
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.copyLink = copyTaskLink;\n})();'), context);
  return { copy: context.copyLink, Toast };
}
test('copies only the exact task URL on the current site, without board filters or a title', async () => {
  const clipboard = { writeText: jest.fn().mockResolvedValue(undefined) };
  const { copy, Toast } = load(clipboard);
  await copy('0681');
  expect(clipboard.writeText).toHaveBeenCalledWith('https://my-agent.example:8443/pipeline?task=0681');
  expect(Toast.success).toHaveBeenCalledWith('Copied');
  expect(Toast.error).not.toHaveBeenCalled();
});
test('an unavailable clipboard produces a useful error without claiming success', async () => {
  const { copy, Toast } = load(undefined);
  await copy('0681');
  expect(Toast.error).toHaveBeenCalledWith(expect.stringContaining('Clipboard unavailable'));
  expect(Toast.success).not.toHaveBeenCalled();
});
test('a denied clipboard exposes the direct task link and never claims it was copied', async () => {
  const error = Object.assign(new Error('Denied'), { name: 'NotAllowedError' });
  const { copy, Toast } = load({ writeText: jest.fn().mockRejectedValue(error) });
  await copy('0681');
  expect(Toast.error).toHaveBeenCalledWith(expect.stringContaining('clipboard access was refused'));
  expect(Toast.error).toHaveBeenCalledWith(expect.stringContaining('https://my-agent.example:8443/pipeline?task=0681'));
  expect(Toast.success).not.toHaveBeenCalled();
});
