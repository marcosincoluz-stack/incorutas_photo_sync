import { describe, it, expect, afterEach } from 'vitest';
const fs = require('fs');
const path = require('path');

const MARKER = path.resolve(__dirname, '../../data/.last_graceful_shutdown');

const { isAutoRestart } = require('../../src/banner');

describe('banner — detección de crash (marcador de graceful shutdown)', () => {
  afterEach(() => {
    try { fs.unlinkSync(MARKER); } catch {}
  });

  it('sin marcador → detecta crash (true)', () => {
    try { fs.unlinkSync(MARKER); } catch {}
    expect(isAutoRestart()).toBe(true);
  });

  it('con marcador → último cierre fue graceful (false) y el marcador se consume (borra)', () => {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, String(Date.now()), 'utf8');

    expect(isAutoRestart()).toBe(false);
    expect(fs.existsSync(MARKER)).toBe(false);
  });

  it('tras consumir el marcador, un siguiente arranque vuelve a detectar crash si el proceso muere abrupto', () => {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, String(Date.now()), 'utf8');

    isAutoRestart(); // consume el marcador
    expect(isAutoRestart()).toBe(true);
  });
});
