import { runInNewContext } from 'node:vm';
import { getErrorMessage } from '@snaglet/shared/utils/errors';

describe('getErrorMessage', () => {
  it('should extract message from Error instance', () => {
    expect(getErrorMessage(new Error('oops'))).toBe('oops');
  });

  it('should return the string itself when thrown as a string', () => {
    expect(getErrorMessage('network failure')).toBe('network failure');
  });

  it('should return the fallback for non-Error objects', () => {
    expect(getErrorMessage({ code: 42 }, 'Unknown')).toBe('Unknown');
  });

  it('should return the fallback for null', () => {
    expect(getErrorMessage(null, 'Something went wrong')).toBe('Something went wrong');
  });

  it('should return the fallback for undefined', () => {
    expect(getErrorMessage(undefined, 'fail')).toBe('fail');
  });

  it('should use default fallback when none provided', () => {
    expect(getErrorMessage(42)).toBe('An unexpected error occurred');
  });
});

describe('cross-realm and empty messages', () => {
  it('reads cross-realm Error', () =>
    expect(getErrorMessage(runInNewContext("new Error('remote')"))).toBe('remote'));
  it('reads serialized error', () =>
    expect(getErrorMessage({ message: 'serialized' })).toBe('serialized'));
  it('falls back for empty Error', () =>
    expect(getErrorMessage(new Error(''), 'fallback')).toBe('fallback'));
  it('falls back for empty object message', () =>
    expect(getErrorMessage({ message: '' }, 'fallback')).toBe('fallback'));
});
