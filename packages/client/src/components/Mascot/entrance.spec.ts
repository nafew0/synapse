import { entrancePose, ENTRANCE_WAITING, ENTRANCE } from './entrance';

const at = (t: number) => {
  const pose = entrancePose(t);
  if (!pose) {
    throw new Error(`no pose at ${t}ms`);
  }
  return pose;
};

const LAND_AT = ENTRANCE.leapFromMs + ENTRANCE.leapMs + ENTRANCE.fallMs;

describe('entrancePose', () => {
  it('starts hidden behind the ground line, with no shadow', () => {
    expect(at(0).drop).toBeGreaterThanOrEqual(ENTRANCE.groundY);
    expect(at(0).shadow).toBe(0);
    expect(ENTRANCE_WAITING.drop).toBeGreaterThanOrEqual(ENTRANCE.groundY);
  });

  it('peeks with its eyes above the ground line, looking left and then right', () => {
    const left = at(ENTRANCE.riseFromMs + ENTRANCE.riseMs + 50);
    expect(left.drop).toBe(ENTRANCE.peekDrop);
    expect(left.drop).toBeLessThan(ENTRANCE.groundY);
    expect(left.gazeX).toBeLessThan(0);
    expect(at(ENTRANCE.lookRightAtMs + 50).gazeX).toBeGreaterThan(0);
    expect(at(ENTRANCE.blinkAtMs + 120).lid).toBeLessThan(0.2);
  });

  it('ducks back down before the leap', () => {
    expect(at(ENTRANCE.leapFromMs - 1).drop).toBeCloseTo(ENTRANCE.duckDrop);
  });

  it('leaps above its resting place and starts grinning on the way up', () => {
    const top = at(ENTRANCE.leapFromMs + ENTRANCE.leapMs - 1);
    expect(top.drop).toBeLessThan(-ENTRANCE.leapHeight * 0.95);
    expect(top.grin).toBe(1);
  });

  it('lands with a squash and a puff, and lets the grin go before it hands over', () => {
    const landing = at(LAND_AT + ENTRANCE.landMs / 2);
    expect(landing.drop).toBe(0);
    expect(landing.squash).toBeGreaterThan(0.15);
    expect(landing.puff).toBeGreaterThan(0);
    expect(landing.shadow).toBe(1);
    expect(at(ENTRANCE.totalMs - 1).grin).toBeCloseTo(0, 1);
    expect(entrancePose(ENTRANCE.totalMs)).toBeNull();
  });
});
