import { BaseFilter, BaseQuery } from '@cubejs-backend/schema-compiler';

const GRANULARITY_TO_INTERVAL: Record<string, (date: string) => string> = {
  day: date => `DATE_TRUNC('day', ${date})`,
  week: date => `DATE_TRUNC('week', ${date})`,
  hour: date => `DATE_TRUNC('hour', ${date})`,
  minute: date => `DATE_TRUNC('minute', ${date})`,
  second: date => `DATE_TRUNC('second', ${date})`,
  month: date => `DATE_TRUNC('month', ${date})`,
  quarter: date => `DATE_TRUNC('quarter', ${date})`,
  year: date => `DATE_TRUNC('year', ${date})`
};

class DuckDBFilter extends BaseFilter {
  public castParameter() {
    const numberTypes = ['number', 'count', 'count_distinct', 'count_distinct_approx', 'sum', 'avg', 'min', 'max'];
    const definition = this.definition();

    if (numberTypes.includes(definition.type)) {
      return 'CAST(? AS DOUBLE)';
    }
   
    return '?';
  }
}

export class DuckDBQuery extends BaseQuery {
  public newFilter(filter: any): BaseFilter {
    return new DuckDBFilter(this, filter);
  }

  public convertTz(field: string) {
    return `timezone('${this.timezone}', ${field}::timestamptz)`;
  }

  public timeGroupedColumn(granularity: string, dimension: string) {
    return GRANULARITY_TO_INTERVAL[granularity](dimension);
  }

  /**
   * Returns sql for source expression floored to timestamps aligned with
   * intervals relative to origin timestamp point.
   * DuckDB operates with whole intervals as is without measuring them in plain seconds,
   * so the resulting date will be human-expected aligned with intervals.
   */
  public dateBin(interval: string, source: string, origin: string): string {
    const timeUnit = this.diffTimeUnitForInterval(interval);
    const beginOfTime = this.dateTimeCast('\'1970-01-01 00:00:00.000\'');

    return `${this.dateTimeCast(`'${origin}'`)} + INTERVAL '${interval}' *
      floor(
        date_diff('${timeUnit}', ${this.dateTimeCast(`'${origin}'`)}, ${source}) /
        date_diff('${timeUnit}', ${beginOfTime}, ${beginOfTime} + INTERVAL '${interval}')
      )::int`;
  }

  public countDistinctApprox(sql: string) {
    return `approx_count_distinct(${sql})`;
  }

  public sqlTemplates() {
    const templates = super.sqlTemplates();
    templates.functions.DATETRUNC = 'DATE_TRUNC({{ args_concat }})';
    // AT TIME ZONE on TIMESTAMPTZ yields a naive TIMESTAMP in UTC (requires the ICU
    // extension, which is bundled and autoloaded in the DuckDB builds used by the driver)
    templates.functions.UTCTIMESTAMP = '(NOW() AT TIME ZONE \'UTC\')';
    templates.functions.LEAST = 'LEAST({{ args_concat }})';
    templates.functions.GREATEST = 'GREATEST({{ args_concat }})';
    // DuckDB returns NaN for correlation with a zero-variance paired input;
    // the PostgreSQL reference returns NULL. REGR_SXX/SYY use the same
    // complete-pair population as CORR, unlike variance over either raw column.
    // Guard finite complete pairs only: a non-finite source observation must
    // retain the source's NaN/error behavior, including singleton inputs.
    templates.functions.CORRELATION = 'CASE WHEN BOOL_AND(ISFINITE({{ args[0] }}) AND ISFINITE({{ args[1] }})) ' +
      'FILTER (WHERE {{ args[0] }} IS NOT NULL AND {{ args[1] }} IS NOT NULL) ' +
      'AND (REGR_SXX({{ args_concat }}) = 0 OR REGR_SYY({{ args_concat }}) = 0) THEN NULL ELSE CORR({{ args_concat }}) END';
    templates.functions.STRING_AGG = 'STRING_AGG({% if distinct %}DISTINCT {% endif %}{{ args[0] }}, COALESCE({{ args[1] }}, \'\'))';
    // DATEADD is being rewritten to DATE_ADD
    templates.functions.DATE_ADD = '({{ args[0] }} + \'{{ interval }} {{ date_part }}\'::interval)';
    delete templates.functions.WIDTH_BUCKET;
    templates.expressions.like = '{{ expr }} {% if negated %}NOT {% endif %}LIKE {{ pattern }}{% if default_escape %} ESCAPE \'\\\'{% endif %}';
    templates.expressions.ilike = '{{ expr }} {% if negated %}NOT {% endif %}ILIKE {{ pattern }}{% if default_escape %} ESCAPE \'\\\'{% endif %}';
    // DuckDB has no default LIKE escape character - the `default_escape` gate on
    // the two templates above exists for exactly that reason. The native planner
    // escapes filter values with a backslash (BaseQuery's `like_escape_char`), so
    // the filter path needs the clause unconditionally to interpret it; without
    // one, `contains '%'` matches nothing instead of the rows containing a
    // literal percent sign.
    templates.tesseract.ilike = '{{ expr }} {% if negated %}NOT {% endif %}ILIKE {{ pattern }} ESCAPE \'\\\'';
    // DuckDB `/` performs float division even for integer operands (since v0.8);
    // `//` is integer division truncating toward zero (-7 // 2 = -3), matching
    // PostgreSQL
    templates.expressions.int_division = '({{ left }} // {{ right }})';
    // Alias the table-function column explicitly. DuckDB's default column is
    // generate_series; Tesseract supplies date_from/date_to expressions over d.
    templates.statements.generated_time_series_select = 'SELECT {{ date_from }} AS "date_from",\n' +
      '{{ date_to }} AS "date_to"\n' +
      'FROM generate_series(CAST({{ start }} AS TIMESTAMP), CAST({{ end }} AS TIMESTAMP), CAST({{ granularity }} AS INTERVAL)) AS series(d)';
    templates.statements.generated_time_series_with_cte_range_source = 'SELECT d AS "date_from",\n' +
      'd + CAST({{ granularity }} AS INTERVAL) - INTERVAL \'1 millisecond\' AS "date_to"\n' +
      'FROM {{ range_source }}, LATERAL generate_series(CAST({{ range_source }}.{{ min_name }} AS TIMESTAMP), CAST({{ range_source }}.{{ max_name }} AS TIMESTAMP), CAST({{ granularity }} AS INTERVAL)) AS series(d)';
    return templates;
  }

  public timeStampParam(timeDimension: any) {
    if (timeDimension.measure) {
      // For time measures, we don't need to check dateFieldType
      return super.timeStampCast('?');
    }
    return super.timeStampParam(timeDimension);
  }
}
