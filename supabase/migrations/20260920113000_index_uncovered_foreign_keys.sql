-- Foreign-key indexes prevent full-table scans during joins, deletes and
-- retention work. Create only indexes not already covered by a valid index
-- whose leading columns match the FK column order.
do $index_fks$
declare
  r record;
  v_columns text;
  v_index_name text;
begin
  for r in
    with fks as (
      select c.oid,c.conrelid,c.conname,c.conkey,
             array_agg(a.attname order by u.ord) as cols
      from pg_constraint c
      cross join lateral unnest(c.conkey) with ordinality u(attnum,ord)
      join pg_attribute a on a.attrelid=c.conrelid and a.attnum=u.attnum
      where c.contype='f' and c.connamespace='public'::regnamespace
      group by c.oid,c.conrelid,c.conname,c.conkey
    )
    select * from fks f
    where not exists (
      select 1 from pg_index i
      where i.indrelid=f.conrelid and i.indisvalid
        and (i.indkey::smallint[])[0:cardinality(f.conkey)-1]=f.conkey
    )
  loop
    select string_agg(quote_ident(x),',') into v_columns from unnest(r.cols) x;
    v_index_name:=left('idx_fk_'||r.conname,63);
    execute format('create index if not exists %I on %s (%s)',v_index_name,r.conrelid::regclass,v_columns);
  end loop;
end $index_fks$;
