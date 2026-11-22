import unittest
from decimal import Decimal
from summary import summarize

class SummaryTests(unittest.TestCase):
    def test_totals(self):
        self.assertEqual(summarize([{'category': 'A', 'amount': '3.2'}, {'category': 'A', 'amount': '0.4'}]), [('A', Decimal('3.6'))])

    def test_empty(self):
        self.assertEqual(summarize([], descending=True), [])

    def test_sort(self):
        data = [{'category': 'A', 'amount': '2'}, {'category': 'B', 'amount': '4'}]
        self.assertEqual(summarize(data, descending=True), [('B', Decimal(4)), ('A', Decimal(2))])
