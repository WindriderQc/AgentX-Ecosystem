const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '../../public/js/nerve-center-cluster.js'),
  'utf8'
);

describe('Nerve Center cluster UI', () => {
  it('uses the host-preference live observation instead of manufacturing an empty loaded-model list', () => {
    expect(source).toContain('pref?.live?.runningModels');
    expect(source).toContain('preferenceRunningModels.length > 0');
    expect(source).not.toContain('ollamaRunningModels: []');
  });

  it('derives loaded-model VRAM and exposes the observation timestamp', () => {
    expect(source).toContain('model?.sizeVram ?? model?.size_vram');
    expect(source).toContain('pref?.live?.observedAt');
  });
});
