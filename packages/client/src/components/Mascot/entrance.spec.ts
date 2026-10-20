import { dropHeightPx, entrancePose, ENTRANCE } from './entrance';

const at = (t: number) => {
  const pose = entrancePose(t);
  if (!pose) {
    throw new Error(`no pose at ${t}ms`);
  }
  return pose;
};

describe('entrancePose', () => {
  it('starts a full drop above, switched off, with the eyes dark', () => {
    const start = at(0);
    expect(start.height).toBe(1);
    expect(start.shade).toBe(1);
    expect(start.led).toBe(0);
    expect(start.lens).toBe(0);
  });

  it('falls faster as it goes, and lands with a squash and a puff', () => {
    const half = at(ENTRANCE.fallMs / 2).height;
    expect(1 - half).toBeLessThan(half);
    const landed = at(ENTRANCE.fallMs + ENTRANCE.thunkMs);
    expect(landed.height).toBe(0);
    expect(landed.squash).toBeCloseTo(ENTRANCE.thunkSquash, 2);
    expect(landed.puff).toBeGreaterThan(0);
  });

  it('settles the squash and the puff before it powers on', () => {
    expect(at(ENTRANCE.fallMs + ENTRANCE.thunkMs + ENTRANCE.settleMs).squash).toBe(0);
    expect(at(ENTRANCE.fallMs + ENTRANCE.puffMs).puff).toBe(-1);
  });

  it('flickers the LED on, then brings the colour up', () => {
    const flicker = Array.from(
      { length: 8 },
      (_, i) => at(ENTRANCE.flickerFromMs + i * ENTRANCE.flickerStepMs).led,
    );
    expect(flicker).toContain(0);
    expect(flicker[flicker.length - 1]).toBe(1);
    expect(at(ENTRANCE.colourFromMs - 1).shade).toBe(1);
    expect(at(ENTRANCE.colourFromMs + ENTRANCE.colourMs).shade).toBe(0);
  });

  it('boots the eyes from a thin line to open', () => {
    expect(at(ENTRANCE.bootFromMs - 1).lens).toBe(0);
    const line = at(ENTRANCE.bootFromMs + ENTRANCE.bootWidthMs);
    expect(line.lens).toBe(1);
    expect(line.lidWidth).toBe(1);
    expect(line.lid).toBeCloseTo(0.06);
    expect(at(ENTRANCE.bootOpenFromMs + ENTRANCE.bootOpenMs).lid).toBeCloseTo(1);
  });

  it('looks left, then right, then hands over to the beat ladder', () => {
    expect(at(1400).gazeX).toBeLessThan(0);
    expect(at(1500).gazeX).toBeGreaterThan(0);
    expect(at(1700).gazeX).toBe(0);
    expect(entrancePose(ENTRANCE.totalMs)).toBeNull();
  });
});

describe('dropHeightPx', () => {
  it('keeps the fall between its bounds', () => {
    expect(dropHeightPx(40)).toBe(ENTRANCE.minDropPx);
    expect(dropHeightPx(250)).toBe(250);
    expect(dropHeightPx(2000)).toBe(ENTRANCE.maxDropPx);
  });
});
