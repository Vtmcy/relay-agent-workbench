import argparse
import csv
import sys
from collections import defaultdict
from decimal import Decimal

def summarize(records, descending=False):
    totals = defaultdict(Decimal)
    for row in records:
        totals[row['category']] += Decimal(row['amount'])
    if descending:
        return sorted(totals.items(), key=lambda item: (-item[1], item[0]))
    return sorted(totals.items())

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('csv_file')
    parser.add_argument('--descending', action='store_true')
    args = parser.parse_args()
    with open(args.csv_file, encoding='utf-8', newline='') as source:
        result = summarize(csv.DictReader(source), args.descending)
    writer = csv.writer(sys.stdout)
    writer.writerow(['category', 'amount'])
    writer.writerows(result)

if __name__ == '__main__':
    main()
