"""Offline historical discovery, bounded transfers, caches and API regression."""
import datetime
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import urlopen
from http.server import ThreadingHTTPServer

import server

ROOT = 'https://www.jpx.co.jp/markets/statistics-equities/margin/tvdivq0000001rnl-att/'
PDF = b'%PDF-1.7\n' + b'x' * 6000 + b'\n%%EOF\n'


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = patch.object(server, 'CACHE_DIR', self.directory.name)
        self.cache.start()
        server.MEM.clear()
        server.MEM_TS.clear()
        server.MEM_META.clear()
        server.reset_upstream()

    def tearDown(self):
        self.cache.stop()
        self.directory.cleanup()

    def test_observed_directory_and_weekends(self):
        candidates = dict(server.history_candidates([('20261005', ROOT + '20261005_mtall.pdf')]))
        self.assertIn('20261002', candidates)
        self.assertNotIn('20261003', candidates)
        self.assertNotIn('20261004', candidates)
        self.assertNotIn('20261006', candidates)  # not yet published
        self.assertNotIn('20260925', candidates)  # weekly era excluded

    def test_no_guess_without_official_url(self):
        self.assertEqual(list(server.history_candidates([('20261005', 'https://other/a.pdf')])),
                         [('20261005', 'https://other/a.pdf')])

    def test_twenty_valid_days_not_calendar_days(self):
        avail = [('20261105', ROOT + '20261105_mtall.pdf')]
        called = []

        def fetch(code, day, url, fresh=False):
            called.append(day)
            if day in ('20261103', '20261012'):  # holidays/missing official files
                return None
            return {'date': datetime.datetime.strptime(day, '%Y%m%d').date().isoformat(), 'buy': 100}

        with patch.object(server, 'upstream_index', return_value=(avail, {'stale': False})), \
             patch.object(server, 'ensure_pdf', return_value=('mock.pdf', True)), \
             patch.object(server, 'fetch_one_day', side_effect=fetch):
            rows, _ = server.gather('7974', 20)
        self.assertEqual(len(rows), 20)
        self.assertEqual(rows, sorted(rows, key=lambda row: row['date']))
        self.assertGreater(len(called), 20)
        self.assertTrue(all(datetime.datetime.strptime(day, '%Y%m%d').weekday() < 5 for day in called))

    def test_404_negative_cache_and_expiry(self):
        url = ROOT + '20261002_mtall.pdf'
        with patch.object(server, 'http_get', side_effect=HTTPError(url, 404, 'missing', None, None)) as get:
            for _ in range(2):
                with self.assertRaises(HTTPError):
                    server.ensure_pdf('20261002', url)
            self.assertEqual(get.call_count, 1)
        with patch.object(server.time, 'time', return_value=server.time.time() + server.MISSING_TTL + 1), \
             patch.object(server, 'http_get', return_value=PDF) as get:
            self.assertTrue(server.ensure_pdf('20261002', url)[1])
            get.assert_called_once()

    def test_disk_pdf_hit_without_download(self):
        Path(self.directory.name, '20261002_mtall.pdf').write_bytes(PDF)
        with patch.object(server, 'http_get') as get:
            self.assertTrue(server.ensure_pdf('20261002', None)[1])
            get.assert_not_called()

    def test_cache_retained_after_index_rotation(self):
        Path(self.directory.name, '20260930_mtall.pdf').write_bytes(PDF)
        candidates = dict(server.history_candidates([('20261007', ROOT + '20261007_mtall.pdf')]))
        self.assertIn('20260930', candidates)
        self.assertIsNone(candidates['20260930'])

    def test_invalid_content_not_cached(self):
        with patch.object(server, 'http_get', return_value=b'<html>missing</html>'):
            with self.assertRaises(ValueError):
                server.ensure_pdf('20261002', ROOT + '20261002_mtall.pdf')
        self.assertFalse(Path(self.directory.name, '20261002_mtall.pdf').exists())

    def test_retry_timeout_and_cooldown(self):
        with patch.object(server, '_network_backoff_until', 0.0), \
             patch.object(server, '_network_last', 0.0), \
             patch.object(server.time, 'sleep'), \
             patch.object(server.urllib.request, 'urlopen', side_effect=TimeoutError('timeout')) as get:
            with self.assertRaises(TimeoutError):
                server.http_get(ROOT + '20261002_mtall.pdf')
            self.assertEqual(get.call_count, 2)
            with self.assertRaises(URLError):
                server.http_get(ROOT + '20261001_mtall.pdf')
            self.assertEqual(get.call_count, 2)

    def test_no_retry_404(self):
        with patch.object(server, '_network_backoff_until', 0.0), \
             patch.object(server.time, 'sleep'), \
             patch.object(server.urllib.request, 'urlopen',
                          side_effect=HTTPError(ROOT, 404, 'missing', None, None)) as get:
            with self.assertRaises(HTTPError):
                server.http_get(ROOT)
            self.assertEqual(get.call_count, 1)

    def test_partial_count_and_health_api(self):
        http = ThreadingHTTPServer(('127.0.0.1', 0), server.H)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        try:
            base = 'http://127.0.0.1:' + str(http.server_port)
            with patch.object(server, 'http_get') as get:
                with urlopen(base + '/api/health') as response:
                    health = json.load(response)
                self.assertTrue(health['ok'])
                self.assertFalse(health['jpxProbed'])
                get.assert_not_called()
            row = {'date': '2026-10-07', 'buy': 100, 'name': 'Test'}
            with patch.object(server, 'gather', return_value=([row], {'stale': False})):
                with urlopen(base + '/api/margin?code=7974&days=20') as response:
                    data = json.load(response)
                self.assertEqual(data['count'], 1)
                self.assertEqual(data['rows'], [row])
                self.assertEqual(data['latest'], '2026-10-07')
                self.assertTrue(data['ok'])
        finally:
            http.shutdown()
            http.server_close()
            thread.join()

    def test_memory_cache_expires(self):
        with patch.object(server.time, 'monotonic', return_value=10.0):
            server.mem_set('7974:20', [{'buy': 100}])
            self.assertIsNotNone(server.mem_get('7974:20'))
        with patch.object(server.time, 'monotonic', return_value=10.0 + server.UPSTREAM_TTL_WARM):
            self.assertIsNone(server.mem_get('7974:20'))

    def test_history_budget_keeps_cached_records(self):
        Path(self.directory.name, '20260930_mtall.pdf').write_bytes(PDF)
        avail = [('20261005', ROOT + '20261005_mtall.pdf')]
        called = []

        def fetch(code, day, url, fresh=False):
            called.append(day)
            return {'date': day, 'buy': 100}

        with patch.object(server, 'HISTORY_BUDGET', 0.0), \
             patch.object(server, 'upstream_index', return_value=(avail, {'stale': False})), \
             patch.object(server, 'fetch_one_day', side_effect=fetch):
            rows, _ = server.gather('7974', 20)
        self.assertEqual(called, ['20261005', '20260930'])
        self.assertEqual(len(rows), 2)

    def test_request_interval(self):
        with patch.object(server, '_network_backoff_until', 0.0), \
             patch.object(server, '_network_last', 0.0), \
             patch.object(server.time, 'monotonic', return_value=0.5), \
             patch.object(server.time, 'sleep') as sleep, \
             patch.object(server.urllib.request, 'urlopen') as get:
            get.return_value.__enter__.return_value.read.return_value = PDF
            self.assertEqual(server.http_get(ROOT, binary=True), PDF)
            sleep.assert_called_once_with(0.5)
            self.assertEqual(get.call_args.kwargs['timeout'], 20)

    def test_offline_index_still_reads_history_cache(self):
        Path(self.directory.name, '20260930_mtall.pdf').write_bytes(PDF)
        with patch.object(server, 'upstream_index', return_value=([], {'stale': True})), \
             patch.object(server, 'parse_pdf', return_value=({'buy': 100}, None)), \
             patch.object(server, 'http_get') as get:
            rows, up = server.gather('7974', 20)
        get.assert_not_called()
        self.assertEqual(len(rows), 1)
        self.assertTrue(up['stale'])


if __name__ == '__main__':
    unittest.main()
