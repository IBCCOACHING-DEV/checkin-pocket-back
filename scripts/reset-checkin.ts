import 'dotenv/config';
import { LocalPrismaService } from '../src/database/local-prisma.service';

// Reseta o check-in de aluno(s) na réplica local (SQLite) desta estação,
// para permitir testar o credenciamento de novo sem esperar sincronização.
//
// Uso:
//   npm run reset-checkin -- <token>                       (um aluno, por token)
//   npm run reset-checkin -- --course "<nome exato da turma>"  (todos os alunos da turma)

const args = process.argv.slice(2);
const courseIndex = args.indexOf('--course');
const COURSE_NAME = courseIndex !== -1 ? args[courseIndex + 1] : undefined;
const TOKEN = courseIndex === -1 ? args[0] : undefined;

async function main() {
  if (!TOKEN && !COURSE_NAME) {
    console.error(
      'Uso: npm run reset-checkin -- <token>  ou  npm run reset-checkin -- --course "<nome da turma>"',
    );
    process.exit(1);
  }

  const prisma = new LocalPrismaService();
  await prisma.onModuleInit();

  try {
    if (COURSE_NAME) {
      const students = await prisma.student.findMany({
        where: { courseName: COURSE_NAME },
      });

      if (students.length === 0) {
        console.error(`Nenhum aluno encontrado na turma "${COURSE_NAME}" na base local.`);
        process.exit(1);
      }

      const checkedInCount = students.filter((s) => s.checkedIn).length;

      await prisma.student.updateMany({
        where: { courseName: COURSE_NAME },
        data: { checkedIn: false, checkedInAt: null, labelPrinted: false },
      });

      console.log(
        `Turma "${COURSE_NAME}": ${students.length} aluno(s) no total, ${checkedInCount} estavam credenciados — todos resetados (checkedIn=false, etiqueta volta a imprimir).`,
      );
      return;
    }

    const student = await prisma.student.findUnique({ where: { token: TOKEN } });

    if (!student) {
      console.error(`Nenhum aluno encontrado com o token "${TOKEN}" na base local.`);
      process.exit(1);
    }

    console.log(
      `Antes: ${student.name} — checkedIn=${student.checkedIn} checkedInAt=${student.checkedInAt}`,
    );

    const updated = await prisma.student.update({
      where: { token: TOKEN },
      data: { checkedIn: false, checkedInAt: null, labelPrinted: false },
    });

    console.log(
      `Depois: ${updated.name} — checkedIn=${updated.checkedIn} checkedInAt=${updated.checkedInAt}`,
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
