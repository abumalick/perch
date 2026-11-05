import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import DeviceEnrolledNotice from './DeviceEnrolledNotice.svelte';
import { setLanguage } from '../i18n.svelte';

const notice = { machine: 'dev', id: 'c590-c6a1-9f8d', name: 'Android · Chrome', at: '2026-11-05T10:00:00.000Z' };

function fakeStore(deviceNotices: unknown[] = []) {
  return { deviceNotices, dismissDeviceNotice: vi.fn() };
}

describe('DeviceEnrolledNotice', () => {
  it('renders nothing without a notice', () => {
    render(DeviceEnrolledNotice, { props: { store: fakeStore() as never } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names the machine, the device and its id, and dismisses it', async () => {
    const store = fakeStore([notice]);
    render(DeviceEnrolledNotice, { props: { store: store as never } });
    expect(screen.getByRole('alert')).toHaveTextContent('New device paired with dev: Android · Chrome (c590-c6a1-9f8d)');
    expect(screen.getByRole('alert')).toHaveTextContent('tarfa devices revoke c590-c6a1-9f8d');
    await fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(store.dismissDeviceNotice).toHaveBeenCalledWith(notice);
  });

  it('speaks French', () => {
    setLanguage('fr');
    try {
      render(DeviceEnrolledNotice, { props: { store: fakeStore([notice]) as never } });
      expect(screen.getByRole('alert')).toHaveTextContent('Nouvel appareil associé à dev');
    } finally {
      setLanguage('en');
    }
  });
});
