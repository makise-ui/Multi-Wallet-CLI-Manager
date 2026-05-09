import { jest } from '@jest/globals';

const mockFs = {
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
};

jest.unstable_mockModule('fs', () => ({
  default: mockFs
}));

const mockDrive = {
  triggerBackup: jest.fn()
};

jest.unstable_mockModule('../drive.js', () => mockDrive);

const core = await import('../core.js');

describe('saveSettings', () => {
  let initialSettingsSnapshot;

  beforeAll(() => {
    // Take a snapshot of the initial settings
    initialSettingsSnapshot = { ...core.USER_SETTINGS };
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset settings to a known state using loadSettings mock or by relying on saveSettings
    // to override everything back. For simplicity, we just save a baseline.
    core.saveSettings({
        currency: 'USD',
        defaultNetwork: 'ethereum',
        gasLimitBuffer: '0',
        backupMethod: null,
        rcloneRemote: null,
        savedTokens: []
    });
    jest.clearAllMocks(); // clear the mock calls from the reset
  });

  it('should merge new settings and write to file', () => {
    const newSettings = { currency: 'EUR' };

    core.saveSettings(newSettings);

    expect(core.USER_SETTINGS.currency).toBe('EUR');
    expect(mockFs.writeFileSync).toHaveBeenCalled();
    const [calledPath, calledData] = mockFs.writeFileSync.mock.calls[0];
    expect(calledPath).toContain('settings.json');
    expect(JSON.parse(calledData)).toEqual(expect.objectContaining({
      currency: 'EUR',
      defaultNetwork: 'ethereum' // ensures it merged
    }));

    expect(mockDrive.triggerBackup).toHaveBeenCalledWith(core.USER_SETTINGS);
  });

  it('should handle merging multiple levels of settings properly', () => {
      const newSettings = { defaultNetwork: 'bsc', savedTokens: ['JMPT'] };
      core.saveSettings(newSettings);

      expect(core.USER_SETTINGS.defaultNetwork).toBe('bsc');
      expect(core.USER_SETTINGS.savedTokens).toEqual(['JMPT']);

      expect(mockFs.writeFileSync).toHaveBeenCalled();
      const [calledPath, calledData] = mockFs.writeFileSync.mock.calls[0];
      const parsedData = JSON.parse(calledData);
      expect(parsedData.defaultNetwork).toBe('bsc');
      expect(parsedData.savedTokens).toEqual(['JMPT']);
  });

  it('should handle undefined or null new settings gracefully', () => {
      // Set to a known state first
      core.saveSettings({ currency: 'GBP' });
      jest.clearAllMocks();

      core.saveSettings(null);
      expect(core.USER_SETTINGS.currency).toBe('GBP');

      core.saveSettings(undefined);
      expect(core.USER_SETTINGS.currency).toBe('GBP');

      // writeFileSync should still have been called twice, writing the same state
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(2);
      expect(mockDrive.triggerBackup).toHaveBeenCalledTimes(2);
  });

  it('should override existing keys with new settings', () => {
      core.saveSettings({ currency: 'JPY', backupMethod: 'rclone' });
      jest.clearAllMocks();

      core.saveSettings({ currency: 'KRW', backupMethod: 'gdrive' });

      expect(core.USER_SETTINGS.currency).toBe('KRW');
      expect(core.USER_SETTINGS.backupMethod).toBe('gdrive');

      expect(mockFs.writeFileSync).toHaveBeenCalled();
      const [calledPath, calledData] = mockFs.writeFileSync.mock.calls[0];
      const parsedData = JSON.parse(calledData);
      expect(parsedData.currency).toBe('KRW');
      expect(parsedData.backupMethod).toBe('gdrive');
  });

  it('should not delete other keys when updating a specific key', () => {
      core.saveSettings({ gasLimitBuffer: '10' });

      expect(core.USER_SETTINGS.currency).toBe('USD'); // Original unaffected
      expect(core.USER_SETTINGS.gasLimitBuffer).toBe('10');
  });
});
