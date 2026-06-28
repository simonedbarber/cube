import { PrestodbQuery } from './PrestodbQuery';

export class TrinoQuery extends PrestodbQuery {
  // Trino doesn't require odd prestodb manual datetime offset calculations
  // as it uses mature timestamps models
  public override convertTz(field) {
    return this.timezone ? `CAST((${field} AT TIME ZONE '${this.timezone}') AS TIMESTAMP)` : field;
  }

  public override sqlTemplates() {
    const templates = super.sqlTemplates();
    // SQL function-template fix: Trino native forms / unsupported deletes
    templates.functions.CHARACTERLENGTH = 'length({{ args[0] }})';
    delete templates.functions.COT;
    delete templates.functions.BITLENGTH;
    delete templates.functions.OCTETLENGTH;
    return templates;
  }
}
