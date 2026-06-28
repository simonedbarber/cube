import { PostgresQuery } from './PostgresQuery';
import { UserError } from '../compiler/UserError';

export class CrateQuery extends PostgresQuery {
  public hllInit(_sql): string {
    throw new UserError('Not implemented yet');
  }

  public hllMerge(_sql): string {
    throw new UserError('Not implemented yet');
  }

  // to implement after merge
  public countDistinctApprox(_sql): string {
    throw new UserError('Not implemented yet');
  }

  public sqlTemplates() {
    const templates = super.sqlTemplates();
    // SQL function-template fix: Crate native forms / unsupported deletes
    templates.functions.VARIANCEPOP = 'VARIANCE({{ args_concat }})';
    templates.functions.LOG10 = 'LOG({{ args_concat }})';
    delete templates.functions.VARIANCE;
    delete templates.functions.COVARIANCE;
    delete templates.functions.COVARIANCEPOP;
    delete templates.functions.CORRELATION;
    delete templates.functions.PERCENTILECONT;
    return templates;
  }
}
