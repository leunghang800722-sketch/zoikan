import argparse
import sys

from .extract import run_extract
from .validate import run_validate
from .wp2b_run import run_wp2b
from .wp3_run import run_wp3
from .wp4_run import run_wp4
from .master_roster import run_wp5_parse


def _print_extract_summary(prefix, summary):
    print(f"{prefix} files={summary['files']} records={summary['records']} "
          f"rows={summary['rows']} unparsed={summary['unparsed']} "
          f"hidden_sheets={summary['hidden_sheets']} "
          f"review_rows={summary['review_rows']}")


def _print_validate_summary(prefix, summary):
    print(f"{prefix} row_total_mismatch={summary['row_total_mismatch']} "
          f"day_total_mismatch={summary['day_total_mismatch']} "
          f"same_day_multi_shift={summary['same_day_multi_shift']} "
          f"missing_staff_no={summary['missing_staff_no']} "
          f"identity_conflicts={summary['identity_conflicts']} "
          f"duplicate_rows_in_file={summary['duplicate_rows_in_file']}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m importer")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("extract", help="① extract: 20×xlsx -> out/wp1/*")
    sub.add_parser("validate", help="④ validate: 內部對數 -> out/wp1/validate-*")
    sub.add_parser("run-wp1", help="extract 跟住 validate 一次過行晒")
    sub.add_parser("run-wp2b", help="③ normalize: 對照表+身份合併+結算單位反推 -> out/wp2b/*")
    sub.add_parser("run-wp3", help="⑤+⑥ rates+report: 價目反推+三份報表 -> out/wp3/*")
    sub.add_parser("run-wp4", help="⑦ reconcile: 三層對數+差異解釋工作簿 -> out/wp4/*")
    sub.add_parser("run-wp5", help="WP5：在勤總表 Roster/Summary 解析 -> out/wp5/*（唔含真名，見 master_roster.py）")

    args = parser.parse_args(argv)

    if args.command == "extract":
        _print_extract_summary("[extract]", run_extract())
        return 0

    if args.command == "validate":
        _print_validate_summary("[validate]", run_validate())
        return 0

    if args.command == "run-wp1":
        _print_extract_summary("[extract]", run_extract())
        _print_validate_summary("[validate]", run_validate())
        return 0

    if args.command == "run-wp2b":
        summary = run_wp2b()
        print(f"[wp2b] guards={summary['guards']} merges={summary['merges']} "
              f"splits={summary['splits']} shift_records={summary['shift_records']} "
              f"broker_conflicts={summary['broker_conflicts']} "
              f"day_mismatch={summary['day_mismatch']} "
              f"unresolved_guards={summary['unresolved_guards']} "
              f"unmapped_sites={summary['unmapped_sites']} "
              f"rule02_overrides={summary.get('rule02_overrides', 0)} "
              f"rule02_conflicts={summary.get('rule02_conflicts', 0)}")
        return 0

    if args.command == "run-wp3":
        summary = run_wp3()
        print(f"[wp3] rate_cards={summary['rate_cards']} solved={summary['solved']} "
              f"pending={summary['pending']} priced={summary['priced']} "
              f"unpriced={summary['unpriced']} "
              f"kai1331_max_resid={summary['kai1331_max_resid']} "
              f"invoice_lines_jul={summary['invoice_lines_jul']} "
              f"roundtrip_diff={summary['roundtrip_diff']} "
              f"payroll_diff={summary['payroll_diff']} "
              f"monthly_diff={summary['monthly_diff']}")
        return 0

    if args.command == "run-wp4":
        summary, rows, _d = run_wp4()
        l1, l2, l3 = (summary["by_layer"].get(k, {}) for k in ("L1", "L2", "L3"))
        print(f"[wp4] total_diffs={summary['total_diffs']} "
              f"needs_review={summary['needs_review_count']} "
              f"L1(explained={l1.get('explained', 0)},awaiting_boss={l1.get('awaiting_boss', 0)}) "
              f"L2(explained={l2.get('explained', 0)},awaiting_boss={l2.get('awaiting_boss', 0)}) "
              f"L3(explained={l3.get('explained', 0)},awaiting_boss={l3.get('awaiting_boss', 0)}) "
              f"cost_column_matched={summary['cost_column_matched']} "
              f"cost_column_diff={summary['cost_column_diff']}")
        return 0

    if args.command == "run-wp5":
        summary = run_wp5_parse()
        print(f"[wp5] posts={summary['posts']} assignments={summary['assignments']} "
              f"summary_rows={summary['summary_rows']} "
              f"unmapped_posts={summary['unmapped_posts']} "
              f"broker_dist={summary['broker_dist']} "
              f"name_redacted_resolved={summary['name_redacted_resolved']} "
              f"name_redacted_unresolved={summary['name_redacted_unresolved']} "
              f"assignments_no_show_excluded={summary['assignments_no_show_excluded']} "
              f"broker_dist_total={summary['broker_dist_total']}")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
