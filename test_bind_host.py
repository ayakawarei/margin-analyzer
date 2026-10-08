"""Check local defaults and explicit container binding without opening a port."""
import unittest
from unittest.mock import patch

import server


class BindHostTests(unittest.TestCase):
    def check_address(self, environ, argv, expected):
        with patch.dict(server.os.environ, environ, clear=True), \
             patch.object(server.sys, 'argv', argv), \
             patch.object(server, 'ThreadingHTTPServer') as http, \
             patch('builtins.print'):
            server.main()
            http.assert_called_once_with(expected, server.H)
            http.return_value.serve_forever.assert_called_once_with()

    def test_local_default(self):
        self.check_address({}, ['server.py'], ('127.0.0.1', 8848))

    def test_container_host_and_custom_port(self):
        self.check_address({'MARGIN_BIND_HOST': '0.0.0.0'},
                           ['server.py', '8849'], ('0.0.0.0', 8849))


if __name__ == '__main__':
    unittest.main()
