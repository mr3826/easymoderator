import { describe, it, expect } from 'vitest';
import { editableHoursAreClosed, editableToHours, hoursToEditable } from '../channelAutomation';

describe('channelAutomation business hours', () => {
  it('round-trips a multi-slot day without dropping slots or the timezone', () => {
    const stored = {
      timezone: 'Asia/Dhaka',
      mon: [
        { open: '09:00', close: '12:00' },
        { open: '14:00', close: '18:00' },
      ],
      tue: { open: '10:00', close: '11:00' },
    };

    const editable = hoursToEditable(stored);

    expect(editable.timezone).toBe('Asia/Dhaka');
    expect(editable.days.mon).toEqual({
      enabled: true,
      slots: [
        { open: '09:00', close: '12:00' },
        { open: '14:00', close: '18:00' },
      ],
    });
    expect(editable.days.tue).toEqual({
      enabled: true,
      slots: [{ open: '10:00', close: '11:00' }],
    });

    expect(editableToHours(editable.timezone, editable.days)).toEqual({
      timezone: 'Asia/Dhaka',
      mon: [
        { open: '09:00', close: '12:00' },
        { open: '14:00', close: '18:00' },
      ],
      tue: { open: '10:00', close: '11:00' },
    });
  });

  it('preserves an overnight range (close earlier than open)', () => {
    const stored = { mon: { open: '22:00', close: '02:00' } };
    const editable = hoursToEditable(stored);

    expect(editable.days.mon.slots).toEqual([{ open: '22:00', close: '02:00' }]);
    expect(editableToHours(editable.timezone, editable.days)).toEqual({
      mon: { open: '22:00', close: '02:00' },
    });
  });

  it('accepts both the single-slot object and multi-slot array shapes', () => {
    const fromObject = hoursToEditable({ wed: { open: '08:30', close: '17:30' } });
    const fromArray = hoursToEditable({
      wed: [
        { open: '08:30', close: '12:00' },
        { open: '13:00', close: '17:30' },
      ],
    });

    expect(fromObject.days.wed.slots).toEqual([{ open: '08:30', close: '17:30' }]);
    expect(fromArray.days.wed.slots).toEqual([
      { open: '08:30', close: '12:00' },
      { open: '13:00', close: '17:30' },
    ]);
    // A single slot keeps the existing `{day:{open,close}}` payload.
    expect(editableToHours('', fromObject.days).wed).toEqual({ open: '08:30', close: '17:30' });
    expect(editableToHours('', fromArray.days).wed).toEqual([
      { open: '08:30', close: '12:00' },
      { open: '13:00', close: '17:30' },
    ]);
  });

  it('treats an empty day array as closed and omits it on save', () => {
    const editable = hoursToEditable({ timezone: 'Asia/Dhaka', mon: [], tue: [] });

    expect(editable.days.mon.enabled).toBe(false);
    expect(editable.days.mon.slots).toEqual([{ open: '09:00', close: '18:00' }]);
    expect(editableToHours(editable.timezone, editable.days)).toEqual({
      timezone: 'Asia/Dhaka',
    });
  });

  it('starts every day disabled with one editable slot when no hours are stored', () => {
    const editable = hoursToEditable(null);

    expect(editable.timezone).toBe('');
    expect(editable.days.sun).toEqual({
      enabled: false,
      slots: [{ open: '09:00', close: '18:00' }],
    });
    expect(editableToHours('', editable.days)).toEqual({});
  });
});

describe('channelAutomation hours-closed detection', () => {
  it('flags an all-disabled schedule as closed (what editableToHours serializes)', () => {
    const editable = hoursToEditable(null);

    expect(editableHoursAreClosed(editable.days)).toBe(true);
    expect(editableToHours('', editable.days)).toEqual({});
  });

  it('flags a timezone-only schedule as closed', () => {
    const editable = hoursToEditable({ timezone: 'Asia/Dhaka', mon: [] });

    expect(editableHoursAreClosed(editable.days)).toBe(true);
    expect(editableToHours(editable.timezone, editable.days)).toEqual({
      timezone: 'Asia/Dhaka',
    });
  });

  it('flags an enabled day whose only slot has empty times as closed', () => {
    const editable = hoursToEditable({});
    editable.days.mon = { enabled: true, slots: [{ open: '', close: '' }] };

    expect(editableHoursAreClosed(editable.days)).toBe(true);
  });

  it('does not flag a normal single-slot schedule', () => {
    const editable = hoursToEditable({ mon: { open: '09:00', close: '18:00' } });

    expect(editableHoursAreClosed(editable.days)).toBe(false);
  });

  it('does not flag a multi-slot schedule with an empty trailing slot', () => {
    const editable = hoursToEditable({
      mon: [
        { open: '09:00', close: '12:00' },
        { open: '14:00', close: '18:00' },
      ],
    });
    editable.days.mon.slots.push({ open: '', close: '' });

    expect(editableHoursAreClosed(editable.days)).toBe(false);
  });
});