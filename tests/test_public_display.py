import unittest
from unittest.mock import patch

from app import app


class PublicDisplayRouteTests(unittest.TestCase):
    def test_public_display_route_is_accessible_without_admin_login(self):
        with app.test_client() as client:
            response = client.get('/events/demo/display')
            self.assertEqual(response.status_code, 200)

    def test_admin_can_export_winners_as_csv(self):
        class FakeResponse:
            def __init__(self, payload, status_code=200):
                self._payload = payload
                self.status_code = status_code

            def json(self):
                return self._payload

        with app.test_client() as client:
            with client.session_transaction() as session:
                session['admin_id'] = 'admin-test'

            with patch('app.requests.get') as mock_get:
                mock_get.side_effect = [
                    FakeResponse({'name': 'Demo Event'}),
                    FakeResponse({
                        'winner-1': {
                            'prize_id': 'prize-1',
                            'winner_id': 'participant-1',
                            'prize_name': 'VIP Pass',
                            'winner_name': 'Alice Carter',
                            'selected_at': '2026-01-01T00:00:00Z'
                        }
                    }),
                ]

                response = client.get('/admin/events/demo/winners/export')

        self.assertEqual(response.status_code, 200)
        self.assertIn('Alice Carter', response.get_data(as_text=True))
        self.assertIn('VIP Pass', response.get_data(as_text=True))


if __name__ == '__main__':
    unittest.main()
