import 'package:flutter_test/flutter_test.dart';

import 'package:field_notes/main.dart';

void main() {
  testWidgets('renders the title', (WidgetTester tester) async {
    await tester.pumpWidget(const MyApp());
    expect(find.text('Field Notes'), findsOneWidget);
  });
}
